require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// Database connection pool (PostgreSQL)
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// Initialize database
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id SERIAL PRIMARY KEY,
                device_sn VARCHAR(50) UNIQUE,
                device_name VARCHAR(100),
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(10) DEFAULT 'offline' CHECK (status IN ('online', 'offline'))
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                emp_id VARCHAR(20) UNIQUE,
                name VARCHAR(100),
                department VARCHAR(50),
                email VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    await client.query(`
            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                device_sn VARCHAR(50),
                emp_id VARCHAR(20),
                punch_time TIMESTAMP,
                punch_state INT, -- 0=CheckIn, 1=CheckOut, 2=Break, 3=Overtime
                verify_mode INT, -- 0=Password, 1=Fingerprint, 15=Face
                work_code VARCHAR(10),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(device_sn, emp_id, punch_time)
            )
        `);

    // Ensure unique constraint exists for existing tables
    try {
      // 1. First, find and delete duplicates to allow constraint creation
      // We keep the record with the largest ID (most recently created)
      await client.query(`
                DELETE FROM attendance a USING (
                    SELECT MIN(id) as id, device_sn, emp_id, punch_time
                    FROM attendance
                    GROUP BY device_sn, emp_id, punch_time
                    HAVING COUNT(*) > 1
                ) b
                WHERE a.device_sn = b.device_sn 
                AND a.emp_id = b.emp_id 
                AND a.punch_time = b.punch_time 
                AND a.id <> b.id
            `);

      // 2. Now try to add the constraint
      await client.query(`
                ALTER TABLE attendance 
                ADD CONSTRAINT attendance_device_sn_emp_id_punch_time_key 
                UNIQUE (device_sn, emp_id, punch_time)
            `);
      console.log("Unique constraint verified/added successfully");
    } catch (error) {
      // If error is 42710 (already exists), we're good
      if (error.code !== "42710" && error.code !== "42P16") {
        console.error("Migration error (Attendance Constraint):", error.message);
      }
    }

    await client.query(`
            CREATE TABLE IF NOT EXISTS device_commands (
                id SERIAL PRIMARY KEY,
                device_sn VARCHAR(50),
                command TEXT,
                status VARCHAR(10) DEFAULT 'pending', -- pending, sent, completed
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Create indexes if they don't exist
    await client.query(`
            CREATE INDEX IF NOT EXISTS idx_emp_date ON attendance (emp_id, punch_time);
            CREATE INDEX IF NOT EXISTS idx_device ON attendance (device_sn);
        `);

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    client.release();
  }
}

// eSSL Device Communication Endpoints

// Device handshake/registration
app.get("/iclock/cdata", async (req, res) => {
  const { SN, options } = req.query;

  console.log(`Device connected: ${SN}`);

  try {
    await pool.query(
      `INSERT INTO devices (device_sn, status, last_activity) 
             VALUES ($1, $2, CURRENT_TIMESTAMP) 
             ON CONFLICT (device_sn) DO UPDATE SET status = $2, last_activity = CURRENT_TIMESTAMP`,
      [SN, "online"]
    );

    // Send response with commands if needed
    res.send("OK");
  } catch (error) {
    console.error("Device registration error:", error);
    res.status(500).send("ERROR");
  }
});

// Receive attendance data from device
app.post("/iclock/cdata", async (req, res) => {
  const data = req.body;
  console.log("Received data from device:", data);

  try {
    const lines = data.toString().trim().split("\n");

    for (const line of lines) {
      if (line.startsWith("ATTLOG")) continue; // Skip header

      const parts = line.split("\t");

      // Handle OPLOG format: OPLOG <emp_id> <device_id> <timestamp> <punch_state> <verify_mode> ...
      if (line.startsWith("OPLOG")) {
        if (parts.length >= 5) {
          const empId = parts[1];
          const timestamp = parts[3];
          const punchState = parts[4];
          const verifyMode = parts[5] || "0";
          const workCode = parts[6] || "";

          await pool.query(
            `INSERT INTO attendance (device_sn, emp_id, punch_time, punch_state, verify_mode, work_code) 
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (device_sn, emp_id, punch_time) DO NOTHING`,
            [
              req.query.SN || "UNKNOWN",
              empId,
              timestamp,
              parseInt(punchState) || 0,
              parseInt(verifyMode) || 0,
              workCode || "",
            ]
          );
        }
      }
      // Handle standard format: <emp_id> <timestamp> <punch_state> <verify_mode> ...
      else if (parts.length >= 4) {
        const [empId, timestamp, punchState, verifyMode, workCode] = parts;
        await pool.query(
          `INSERT INTO attendance (device_sn, emp_id, punch_time, punch_state, verify_mode, work_code) 
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (device_sn, emp_id, punch_time) DO NOTHING`,
          [
            req.query.SN || "UNKNOWN",
            empId,
            timestamp,
            parseInt(punchState) || 0,
            parseInt(verifyMode) || 0,
            workCode || "",
          ]
        );
      }
    }

    console.log(`Processed attendance data`);
    res.send("OK");
  } catch (error) {
    console.error("Attendance data processing error:", error);
    res.status(500).send("ERROR");
  }
});

// Device status update (heartbeat) and command retrieval
app.all("/iclock/getrequest", async (req, res) => {
  const { SN } = req.query;

  if (SN) {
    console.log(`Heartbeat from device: ${SN} [${req.method}]`);
    // Update status
    await pool.query(
      "UPDATE devices SET status = $1, last_activity = CURRENT_TIMESTAMP WHERE device_sn = $2",
      ["online", SN]
    );

    // Check for pending commands
    try {
      const pendingCommands = await pool.query(
        "SELECT id, command FROM device_commands WHERE device_sn = $1 AND status = 'pending' ORDER BY created_at LIMIT 1",
        [SN]
      );

      if (pendingCommands.rows.length > 0) {
        const cmd = pendingCommands.rows[0];
        console.log(`Sending command to device ${SN}: ${cmd.command}`);

        // Update status to sent
        await pool.query(
          "UPDATE device_commands SET status = 'sent' WHERE id = $1",
          [cmd.id]
        );

        // Send command to device
        return res.send(cmd.command);
      }
    } catch (error) {
      console.error("Error checking pending commands:", error);
    }
  } else {
    console.log(`Heartbeat received but no SN in query: ${JSON.stringify(req.query)}`);
  }

  res.send("OK");
});

// Endpoint to receive data requested via DATA QUERY
app.post("/iclock/querydata", async (req, res) => {
  const { SN } = req.query;
  const data = req.body;
  console.log(`Received query data from device ${SN}`);

  try {
    const lines = data.toString().trim().split("\n");

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 4) {
        const [empId, timestamp, punchState, verifyMode, workCode] = parts;
        await pool.query(
          `INSERT INTO attendance (device_sn, emp_id, punch_time, punch_state, verify_mode, work_code) 
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (device_sn, emp_id, punch_time) DO NOTHING`,
          [
            SN || "UNKNOWN",
            empId,
            timestamp,
            parseInt(punchState) || 0,
            parseInt(verifyMode) || 0,
            workCode || "",
          ]
        );
      }
    }

    // Mark commands as completed for this device
    await pool.query(
      "UPDATE device_commands SET status = 'completed' WHERE device_sn = $1 AND status = 'sent'",
      [SN]
    );

    res.send("OK");
  } catch (error) {
    console.error("Error processing query data:", error);
    res.status(500).send("ERROR");
  }
});

// API Endpoints for Web Dashboard

// Get all employees
app.get("/api/employees", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM employees ORDER BY name");
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// Add new employee
app.post("/api/employees", async (req, res) => {
  const { emp_id, name, department, email } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO employees (emp_id, name, department, email) VALUES ($1, $2, $3, $4) RETURNING id",
      [emp_id, name, department, email]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error("Error adding employee:", error);
    res.status(500).json({ error: "Failed to add employee" });
  }
});

// Get attendance records with filters
app.get("/api/attendance", async (req, res) => {
  const { emp_id, start_date, end_date, limit = 100 } = req.query;

  try {
    let query = `
            SELECT a.*, e.name, e.department 
            FROM attendance a 
            LEFT JOIN employees e ON a.emp_id = e.emp_id 
            WHERE 1=1
        `;
    const params = [];
    let paramIndex = 1;

    if (emp_id) {
      query += ` AND a.emp_id = $${paramIndex++}`;
      params.push(emp_id);
    }

    if (start_date) {
      query += ` AND a.punch_time >= $${paramIndex++}`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND a.punch_time <= $${paramIndex++}`;
      params.push(end_date);
    }

    query += ` ORDER BY a.punch_time DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching attendance:", error);
    res.status(500).json({ error: "Failed to fetch attendance records" });
  }
});

// Get today's attendance summary
app.get("/api/attendance/today", async (req, res) => {
  try {
    const summary = await pool.query(`
            SELECT 
                COUNT(DISTINCT emp_id) as present_count,
                COUNT(*) as total_punches,
                MAX(punch_time) as last_punch
            FROM attendance 
            WHERE DATE(punch_time) = CURRENT_DATE
        `);

    const totalEmployees = await pool.query(
      "SELECT COUNT(*) as total FROM employees"
    );

    res.json({
      present: parseInt(summary.rows[0].present_count) || 0,
      total: parseInt(totalEmployees.rows[0].total) || 0,
      total_punches: parseInt(summary.rows[0].total_punches) || 0,
      last_punch: summary.rows[0].last_punch,
    });
  } catch (error) {
    console.error("Error fetching today summary:", error);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// Get device status
app.get("/api/devices", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM devices ORDER BY last_activity DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching devices:", error);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Trigger full sync (backfill) for a device
app.post("/api/devices/:sn/sync", async (req, res) => {
  const { sn } = req.params;

  try {
    // Queue the DATA QUERY command
    await pool.query(
      "INSERT INTO device_commands (device_sn, command, status) VALUES ($1, $2, $3)",
      [sn, "C:99:DATA QUERY - tablename=ATTLOG,fielddesc=*,filter=*", "pending"]
    );

    res.json({
      success: true,
      message: `Sync command queued for device ${sn}. It will be sent on next heartbeat.`,
    });
  } catch (error) {
    console.error("Error queueing sync command:", error);
    res.status(500).json({ error: "Failed to queue sync command" });
  }
});

// Get attendance report (daily summary)
app.get("/api/reports/daily", async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    const query = `
            SELECT 
                e.emp_id,
                e.name,
                e.department,
                DATE(a.punch_time) as date,
                MIN(CASE WHEN a.punch_state = 0 THEN a.punch_time END) as check_in,
                MAX(CASE WHEN a.punch_state = 1 THEN a.punch_time END) as check_out,
                COUNT(*) as total_punches
            FROM attendance a
            JOIN employees e ON a.emp_id = e.emp_id
            WHERE DATE(a.punch_time) BETWEEN $1 AND $2
            GROUP BY e.emp_id, e.name, e.department, DATE(a.punch_time)
            ORDER BY date DESC, e.name
        `;

    const result = await pool.query(query, [start_date, end_date]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error generating report:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// Serve dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`ADMS Server running on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`Device endpoint: http://localhost:${PORT}/iclock/cdata`);
  });
}

startServer();
