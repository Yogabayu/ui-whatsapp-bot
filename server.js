const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use(
  session({
    secret: "thisisasecretkey",
    resave: false,
    saveUninitialized: true,
  })
);

// Database connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "bot_wa",
});

db.connect((err) => {
  if (err) throw err;
  console.log("Connected to database");
});

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let connectionStatus = "Disconnected";

// QR Code Generation
client.on("qr", (qr) => {
  console.log("QR Code received");
  connectionStatus = "QR Code received, please scan";
  
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error("Error generating QR code:", err);
      return;
    }
    io.emit("qr", url);
    console.log("QR code URL generated and emitted to client");
  });
});

client.on("ready", () => {
  console.log("WhatsApp client is ready!");
  connectionStatus = "Connected";
  io.emit("ready");
});

client.on("authenticated", () => {
  console.log("Client authenticated");
  connectionStatus = "Authenticated";
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failure:", msg);
  connectionStatus = "Authentication failed";
});

// Message handling with improved group chat detection
client.on("message", async (msg) => {
  console.log("--- New Message Received ---");
  
  try {
    // Check if message is from a group chat based on the ID format
    const isGroup = msg.from.endsWith('@g.us');
    const isBroadcast = msg.from.endsWith('@broadcast');
    
    console.log(`Message from: ${msg.from}`);
    console.log(`Is Group Chat (by ID): ${isGroup}`);
    console.log(`Is Broadcast: ${isBroadcast}`);
    
    if (isBroadcast) {
      console.log("Message is a broadcast - ignoring");
      return;
    }
    // Skip processing if it's a group chat
    if (isGroup) {
      console.log("Message from group chat - ignoring");
      return;
    }
    
    console.log("Processing personal chat message");
    console.log(`Message content: ${msg.body}`);
    
    // Process replies for personal chats only
    const [replies] = await db.promise().query("SELECT * FROM reply");
    for (const reply of replies) {
      if (msg.body.toLowerCase().includes(reply.message.toLowerCase())) {
        console.log(`Matched keyword: ${reply.message}`);
        console.log(`Sending reply: ${reply.reply}`);
        await msg.reply(reply.reply);
        break; // Stop after first match
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
  }
  
  console.log("--- Message Processing Complete ---");
});

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.query(
    "SELECT * FROM users WHERE username = ?",
    [username],
    (err, results) => {
      if (err) throw err;
      if (results.length > 0) {
        bcrypt.compare(password, results[0].password, (err, result) => {
          if (result) {
            req.session.loggedin = true;
            req.session.username = username;
            res.redirect("/dashboard");
          } else {
            res.send("Incorrect username or password");
          }
        });
      } else {
        res.send("Incorrect username or password");
      }
    }
  );
});

const checkLogin = (req, res, next) => {
  if (req.session?.loggedin) {
    next();
  } else {
    res.redirect("/");
  }
};

app.get("/dashboard", checkLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.get("/status", checkLogin, (req, res) => {
  res.json({ status: connectionStatus });
});

app.post("/send-message", checkLogin, (req, res) => {
  const { number, message } = req.body;
  client
    .sendMessage(`${number}@c.us`, message)
    .then(() => res.json({ success: true }))
    .catch((err) =>
      res.status(500).json({ success: false, error: err.message })
    );
});

io.on("connection", (socket) => {
  console.log("New client connected");
  // Send current status when client connects
  socket.emit("status", { status: connectionStatus });
  
  if (connectionStatus === "QR Code received, please scan") {
    // Re-generate QR code for new connections if not authenticated
    client.getState().then(state => {
      if (state !== "CONNECTED") {
        console.log("Requesting new QR code");
        // This will trigger the qr event again
        client.resetState();
      }
    });
  }
  
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

app.post("/add-auto-reply", checkLogin, (req, res) => {
  const { keyword, response } = req.body;
  db.query(
    "INSERT INTO reply (message, reply) VALUES (?, ?)",
    [keyword, response],
    (err, results) => {
      if (err) throw err;
      res.json({ success: true });
    }
  );
});

app.get("/get-auto-replies", checkLogin, (req, res) => {
  db.query("SELECT * FROM reply", (err, results) => {
    if (err) throw err;
    res.json(results);
  });
});

app.delete("/delete-auto-reply/:id", checkLogin, (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM reply WHERE id = ?", [id], (err, results) => {
    if (err) throw err;
    res.json({ success: true });
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// Initialize WhatsApp client
console.log("Initializing WhatsApp client...");
client.initialize();