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
  password: "yOg@21121998",
  database: "whatsapp",
});

db.connect((err) => {
  if (err) throw err;
  console.log("Connected to database");
});

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
});

let connectionStatus = "Disconnected";

client.on("qr", (qr) => {
  qrcode.toDataURL(qr, (err, url) => {
    io.emit("qr", url);
    connectionStatus = "QR Code received, please scan";
  });
});

client.on("ready", () => {
  connectionStatus = "Connected";
  io.emit("ready");
});

// Add this at the top of your file, outside of any functions
let isProcessingGroupMessage = false;

// Override the client's sendMessage method to log all send attempts
const originalSendMessage = client.sendMessage;
client.sendMessage = function (chatId, content, options) {
  console.log(`Attempt to send message to ${chatId}: ${content}`);
  if (isProcessingGroupMessage) {
    console.log("Blocked send attempt to group chat");
    return Promise.resolve(); // Don't actually send the message
  }
  return originalSendMessage.call(this, chatId, content, options);
};

client.on("message", async (msg) => {
  console.log("--- New Message Received ---");
  let chat;
  try {
    chat = await msg.getChat();
    console.log(`Chat Type: ${chat.isGroup ? "Group" : "Personal"}`);
    console.log(`Is Group (direct check): ${chat.isGroup}`);
    console.log(
      `Participant Count: ${
        chat.participants ? chat.participants.length : "N/A"
      }`
    );
  } catch (error) {
    console.error("Error getting chat:", error);
    return;
  }

  // Robust group chat check
  const isGroupChat =
    chat.isGroup || (chat.participants && chat.participants.length > 2);

  if (isGroupChat) {
    console.log("This is a group chat. Ignoring message.");
    isProcessingGroupMessage = true;
    // Set a timeout to reset the flag, in case the message processing is asynchronous
    setTimeout(() => {
      isProcessingGroupMessage = false;
    }, 1000); // Reset after 1 second
    return;
  }

  if (msg.fromMe) {
    for (const [id, reply] of autoReplies) {
      if (msg.body.toLowerCase().includes(reply.keyword.toLowerCase())) {
        await msg.reply(reply.response);
        return; // Stop after first match
      }
    }
  }

  isProcessingGroupMessage = false;

  console.log("Processing personal chat message");

  for (const [id, reply] of autoReplies) {
    if (msg.body.toLowerCase().includes(reply.keyword.toLowerCase())) {
      await msg.reply(reply.response);
      return; // Stop after first match
    }
  }
  console.log("--- Message Processing Complete ---");
});

client.initialize();

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
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

const autoReplies = new Map();

app.post("/add-auto-reply", checkLogin, (req, res) => {
  //   const { keyword, response } = req.body;
  //   const id = Date.now().toString(); // Simple unique ID
  //   autoReplies.set(id, { id, keyword, response });
  //   res.json({ success: true, id });

  const { keyword, response } = req.body;
  db.query(
    "INSERT INTO reply ( message, reply) VALUES ( ?, ?)",
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
