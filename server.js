const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const FALLBACK_MS = 10000;   // 10 seconds

// Serve the files inside the "public" folder
app.use(express.static("public"));

// Runs every time a user connects
let waitingList = [];   // users waiting: { socket, interests }
const partners = {};           // stores who is paired with whom
const blocked = {};   // blocked[socketId] = Set of socket ids they blocked

// Disconnects a user from their partner and tells the partner
function leavePartner(socket) {
  const partnerId = partners[socket.id];

  if (partnerId) {
    io.to(partnerId).emit("partner-left");
    delete partners[partnerId];
    delete partners[socket.id];
  }

      // Cancel any fallback timer for this user, then remove them from the list
  waitingList
    .filter((u) => u.socket === socket)
    .forEach((u) => clearTimeout(u.timer));
  waitingList = waitingList.filter((u) => u.socket !== socket);
}

// Tells every connected user how many people are online
function broadcastOnlineCount() {
  io.emit("online-count", io.sockets.sockets.size);
}

// Cleans the interests sent by the browser (never trust user input)
function cleanInterests(interests) {
  if (!Array.isArray(interests)) return [];
  const cleaned = interests
    .filter((i) => typeof i === "string")
    .map((i) => i.trim().toLowerCase().slice(0, 20))
    .filter((i) => i.length > 0);
  return [...new Set(cleaned)].slice(0, 5);   // remove duplicates, max 5
}

// Two users are compatible if either has no interests, or they share one
function isCompatible(socketA, interestsA, socketB, interestsB) {
  // Never match if either side blocked the other
  if (blocked[socketA.id]?.has(socketB.id)) return false;
  if (blocked[socketB.id]?.has(socketA.id)) return false;

  if (interestsA.length === 0 || interestsB.length === 0) return true;
  return interestsA.some((i) => interestsB.includes(i));
}

// Pairs two users and tells both they are matched
function pairUsers(a, b, shared) {
  partners[a.id] = b.id;
  partners[b.id] = a.id;
  a.emit("matched", shared);
  b.emit("matched", shared);
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  broadcastOnlineCount();

  // User clicks "Start"
      socket.on("find-partner", (interests) => {
    leavePartner(socket);

    const myInterests = cleanInterests(interests);

    const index = waitingList.findIndex((u) =>
      isCompatible(socket, myInterests, u.socket, u.interests)
    );

    if (index !== -1) {
      // Found a compatible user right away
      const partner = waitingList.splice(index, 1)[0];
      clearTimeout(partner.timer);
      const shared = myInterests.filter((i) => partner.interests.includes(i));
      pairUsers(socket, partner.socket, shared);
      return;
    }

    // No match yet: wait, but set a fallback timer
    const entry = { socket, interests: myInterests, timer: null };
    waitingList.push(entry);
    socket.emit("waiting");

    entry.timer = setTimeout(() => {
      // Look for ANYONE waiting (ignoring interests, still respecting blocks)
      const i = waitingList.findIndex(
        (u) => u !== entry && isCompatible(socket, [], u.socket, [])
      );

      if (i === -1) {
        // Nobody at all, so stay in the list but open to anyone
        entry.interests = [];
        return;
      }

      const partner = waitingList.splice(i, 1)[0];
      clearTimeout(partner.timer);
      waitingList = waitingList.filter((u) => u !== entry);
      pairUsers(socket, partner.socket, []);
    }, FALLBACK_MS);
  });

    // User sends a message
  socket.on("send-message", (message) => {
    const partnerId = partners[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("receive-message", message);
    }
  });

    // User is typing
  socket.on("typing", () => {
    const partnerId = partners[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-typing");
    }
  });

      // User blocks their current partner
  socket.on("block", () => {
    const partnerId = partners[socket.id];
    if (!partnerId) return;

    if (!blocked[socket.id]) blocked[socket.id] = new Set();
    blocked[socket.id].add(partnerId);

    leavePartner(socket);
    socket.emit("blocked-done");
  });

  // User reports their current partner
  socket.on("report", (reason) => {
    const partnerId = partners[socket.id];
    if (!partnerId) return;

    const entry = {
      time: new Date().toISOString(),
      reporter: socket.id,
      reported: partnerId,
      reason: typeof reason === "string" ? reason.slice(0, 200) : "",
    };
    fs.appendFileSync("reports.log", JSON.stringify(entry) + "\n");

    // Reporting also blocks, so you don't meet them again
    if (!blocked[socket.id]) blocked[socket.id] = new Set();
    blocked[socket.id].add(partnerId);

    leavePartner(socket);
    socket.emit("report-done");
  });

  socket.on("disconnect", () => {
    console.log("A user disconnected:", socket.id);
    leavePartner(socket);
    broadcastOnlineCount(); 
    delete blocked[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});