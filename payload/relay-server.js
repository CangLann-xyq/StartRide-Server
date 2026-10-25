const net = require("net");

const http = require("http");

const crypto = require("crypto");

const fs = require("fs");

const https = require("https");

const TCP_PORT = process.env.PORT || 7777;

const HTTP_PORT = process.env.HTTP_PORT || 7788;

const HTTP_HOST = process.env.SR_HTTP_HOST || "127.0.0.1";

const RELAY_VERSION = "2.7.0";

const ROOM_TTL_MS = 90 * 1e3;

const PLAYER_LIST_INTERVAL = 5e3;

const IDLE_PING_INTERVAL = 25e3;

const HOST_GRACE_MS = parseInt(process.env.SR_HOST_GRACE_MS, 10) || 3e4;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const FORWARD_TYPES = new Set([ "vehicle", "vehcfg", "chat", "mode-phase", "mode-sync", "mode-impact", "mode-spawn-plan", "mode-placement", "derby-damage", "derby-down", "hide-seek-stage", "hide-seek-found", "hide-seek-skill" ]);

const SELF_ID_TYPES = new Set([ "mode-placement", "mode-impact", "derby-damage", "derby-down", "hide-seek-skill" ]);

let tcpAccepted = 0;

let wsAccepted = 0;

const rooms = new Map;

const recentlyClosed = new Map;

function getPlayerList(roomId) {
  const r = rooms.get(roomId);
  if (!r) return [];
  const list = [];
  for (const [, info] of r.sockets) {
    list.push({
      name: info.name,
      id: info.id,
      version: info.version || "",
      host: info.isHost ? 1 : 0
    });
  }
  return list;
}

function roomState(roomId) {
  const r = rooms.get(roomId);
  if (!r) {
    return {
      count: 0,
      players: [],
      closed: recentlyClosed.has(roomId),
      capacity: 0,
      host: "",
      roomName: "",
      gameMode: "",
      gameModeRevision: 0
    };
  }
  return {
    count: r.sockets.size,
    players: getPlayerList(roomId),
    closed: r.closed,
    capacity: r.meta.capacity || 0,
    host: r.meta.host || "",
    roomName: r.meta.roomName || r.meta.name || "",
    gameMode: r.meta.gameMode || "",
    gameModeRevision: r.meta.gameModeRevision || 0,
    lastActive: r.lastActive
  };
}

const LIVE_PLAYER_TTL = 3e4;

const LIVE_ROOM_TTL = 6e5;

const LIVE_IMPACT_MAX = 30;

const liveRooms = new Map;

const REGISTRY_TTL_MS = 3e5;

const registry = new Map;

const AGGREGATE = process.env.SR_AGGREGATE !== "0";

const AGG_INTERVAL_MS = 2e4;

const AGG_TIMEOUT_MS = 6e3;

const AGG_MAX_SERVERS = 24;

const remoteLive = new Map;

function aggFetchOne(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  const mod = u.protocol === "https:" ? https : http;
  const req2 = mod.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: "/api/startride/live",
    method: "GET",
    timeout: AGG_TIMEOUT_MS
  }, res2 => {
    let b = "";
    res2.on("data", c => {
      b += c;
      if (b.length > 1048576) req2.destroy();
    });
    res2.on("end", () => {
      try {
        const d = JSON.parse(b);
        const list = Array.isArray(d && d.rooms) ? d.rooms : [];
        remoteLive.set(url, {
          url: url,
          rooms: list,
          ts: Date.now()
        });
      } catch (e) {
        remoteLive.delete(url);
      }
    });
  });
  req2.on("error", () => {});
  req2.on("timeout", () => req2.destroy());
  req2.end();
}

function aggTick() {
  if (!AGGREGATE) return;
  const now = Date.now();
  for (const [k, v] of remoteLive) {
    if (now - v.ts > 9e4) remoteLive.delete(k);
  }
  let n = 0;
  for (const [k, s] of registry) {
    if (now - s.lastSeen > REGISTRY_TTL_MS) continue;
    if (n >= AGG_MAX_SERVERS) break;
    n++;
    aggFetchOne(k);
  }
}

if (AGGREGATE) setInterval(aggTick, AGG_INTERVAL_MS).unref();

function trackTelemetry(roomId, msg) {
  if (msg.type === "vehicle") {
    let lr = liveRooms.get(roomId);
    if (!lr) {
      lr = {
        t: 0,
        players: new Map,
        impacts: []
      };
      liveRooms.set(roomId, lr);
    }
    lr.t = Date.now();
    lr.players.set(String(msg.id || msg.name || "player"), {
      id: String(msg.id || "").slice(0, 40),
      name: String(msg.name || "").slice(0, 32),
      model: String(msg.model || "").slice(0, 48),
      map: String(msg.map || "").slice(0, 32),
      pos: Array.isArray(msg.pos) ? msg.pos.slice(0, 3).map(Number) : [],
      rot: Array.isArray(msg.rot) ? msg.rot.slice(0, 4).map(Number) : [],
      vel: Array.isArray(msg.vel) ? msg.vel.slice(0, 3).map(Number) : [],
      t: Date.now()
    });
    return;
  }
  if (msg.type === "mode-impact" || msg.type === "derby-damage") {
    let lr = liveRooms.get(roomId);
    if (!lr) {
      lr = {
        t: Date.now(),
        players: new Map,
        impacts: []
      };
      liveRooms.set(roomId, lr);
    }
    lr.t = Date.now();
    lr.impacts.push({
      t: Date.now(),
      kind: msg.type,
      by: String(msg.id || "").slice(0, 40),
      target: String(msg.target || "").slice(0, 40),
      damage: Math.max(0, Math.round(Number(msg.damage) || 0)),
      speed: Math.max(0, Math.round(Number(msg.speed) || 0))
    });
    if (lr.impacts.length > LIVE_IMPACT_MAX) lr.impacts.splice(0, lr.impacts.length - LIVE_IMPACT_MAX);
  }
}

function livePrune() {
  const now = Date.now();
  for (const [id, lr] of liveRooms) {
    if (now - lr.t > LIVE_ROOM_TTL && !rooms.has(id)) {
      liveRooms.delete(id);
      continue;
    }
    for (const [pid, pl] of lr.players) {
      if (now - pl.t > LIVE_PLAYER_TTL) lr.players.delete(pid);
    }
  }
}

setInterval(livePrune, 15e3).unref();

function liveSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [id, r] of rooms) {
    const lr = liveRooms.get(id);
    const players = [];
    if (lr) for (const [, pl] of lr.players) players.push(pl);
    out.push({
      id: id,
      name: r.meta && (r.meta.roomName || r.meta.name) || id,
      host: r.meta && r.meta.host || "",
      mode: r.meta && r.meta.gameMode || "free_drive",
      count: r.sockets.size,
      capacity: r.meta && r.meta.capacity || 0,
      players: players,
      impacts: lr ? lr.impacts.filter(x => now - x.t < 6e4) : []
    });
  }
  for (const [id, lr] of liveRooms) {
    if (rooms.has(id) || lr.players.size === 0) continue;
    out.push({
      id: id,
      name: id,
      host: "",
      mode: "free_drive",
      count: 0,
      capacity: 0,
      players: Array.from(lr.players.values()),
      impacts: []
    });
  }
  for (const [, pack] of remoteLive) {
    if (Date.now() - pack.ts > 9e4) continue;
    for (const r of pack.rooms) {
      if (!r || r.via) continue;
      if (!(r.count > 0 || Array.isArray(r.players) && r.players.length)) continue;
      out.push(Object.assign({}, r, {
        via: urlHostOf(pack.url)
      }));
    }
  }
  return out;
}

function urlHostOf(u) {
  try {
    const x = new URL(u);
    return x.host;
  } catch (e) {
    return "";
  }
}

function broadcast(roomId, msg, exceptSocket) {
  const r = rooms.get(roomId);
  if (!r) return;
  const data = JSON.stringify(msg) + "\n";
  for (const [s] of r.sockets) {
    if (s !== exceptSocket && !s.destroyed) {
      try {
        s.write(data);
      } catch (e) {}
    }
  }
}

function pushPlayerList(roomId) {
  const st = roomState(roomId);
  broadcast(roomId, {
    type: "players",
    players: st.players,
    count: st.count,
    capacity: st.capacity,
    host: st.host,
    roomName: st.roomName,
    gameMode: st.gameMode,
    gameModeRevision: st.gameModeRevision
  });
}

const KNOWN_GAME_MODES = new Set([ "free_drive", "hide_seek", "cops_robber", "derby", "track_day" ]);

const GAME_MODE_REVISIONS = {
  free_drive: 1,
  hide_seek: 1,
  cops_robber: 1,
  derby: 1,
  track_day: 1
};

function sanitizeGameMode(value) {
  const s = String(value || "").slice(0, 24);
  return KNOWN_GAME_MODES.has(s) ? s : "";
}

function closeRoom(roomId, by, token, reason) {
  const r = rooms.get(roomId);
  if (!r) return {
    ok: false,
    error: "房间不存在或已结束"
  };
  if (by && r.meta.host && by !== r.meta.host) {
    return {
      ok: false,
      error: "只有房主可以关闭房间"
    };
  }
  if (r.meta.token && token !== r.meta.token) {
    return {
      ok: false,
      error: "房间令牌不匹配"
    };
  }
  r.closed = true;
  recentlyClosed.set(roomId, Date.now());
  broadcast(roomId, {
    type: "room-closed",
    text: reason || "房主已关闭房间",
    by: by || r.meta.host || ""
  });
  for (const [s] of r.sockets) {
    try {
      s.destroy();
    } catch (e) {}
  }
  r.sockets.clear();
  rooms.delete(roomId);
  console.log(`[${roomId}] closed by ${by || "host"}`);
  return {
    ok: true
  };
}

function attachConnection(socket, via) {
  let roomId = null;
  let playerName = null;
  let playerId = null;
  let buffer = "";
  function leaveRoom() {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (r) {
      const who = r.sockets.get(socket);
      r.sockets.delete(socket);
      r.lastActive = Date.now();
      broadcast(roomId, {
        type: "system",
        text: `${playerName} 离开了游戏`
      });
      pushPlayerList(roomId);
      if (who && who.isHost && r.meta.host === who.name && r.sockets.size > 0) {
        r.hostLeftAt = Date.now();
        broadcast(roomId, {
          type: "system",
          text: "房主连接中断，正在等待重连…"
        });
      }
      console.log(`[${roomId}] ${playerName} left (${r.sockets.size} players)`);
      if (r.sockets.size === 0) {
        rooms.delete(roomId);
        console.log(`[${roomId}] empty, removed`);
      }
    }
    roomId = null;
  }
  socket.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!msg) continue;
      if (msg.type === "join" && msg.roomId) {
        if (roomId === msg.roomId) {
          const rNow = rooms.get(roomId);
          if (rNow && rNow.sockets.has(socket)) {
            const newName = String(msg.playerName || "Player").slice(0, 30);
            const newId = String(msg.playerId || newName).slice(0, 40);
            const entry = rNow.sockets.get(socket);
            const changed = entry.name !== newName || entry.id !== newId;
            entry.name = newName;
            entry.id = newId;
            entry.version = String(msg.version || entry.version || "").slice(0, 16);
            try {
              socket.write(JSON.stringify(Object.assign({
                type: "players"
              }, roomState(roomId))) + "\n");
            } catch (e) {}
            if (changed) pushPlayerList(roomId);
            rNow.lastActive = Date.now();
            console.log(`[${roomId}] ${newName} re-joined (same socket), snapshot resent`);
          }
          continue;
        }
        leaveRoom();
        roomId = String(msg.roomId);
        playerName = String(msg.playerName || "Player").slice(0, 30);
        playerId = String(msg.playerId || playerName).slice(0, 40);
        let r = rooms.get(roomId);
        const existingHost = r ? String(r.meta.host || "") : "";
        const claimsHost = String(msg.host || "") !== "" && String(msg.host) === String(playerName) && (existingHost === "" || existingHost === String(playerName));
        if (!r) {
          const initialMode = sanitizeGameMode(msg.gameMode) || "free_drive";
          r = {
            sockets: new Map,
            meta: {
              name: roomId,
              roomName: String(msg.roomName || "").slice(0, 40),
              host: String(msg.host || playerName).slice(0, 30),
              capacity: parseInt(msg.capacity, 10) || 8,
              gameMode: initialMode,
              gameModeRevision: GAME_MODE_REVISIONS[initialMode] || 1,
              token: String(msg.token || "")
            },
            closed: false,
            lastActive: Date.now()
          };
          rooms.set(roomId, r);
          recentlyClosed.delete(roomId);
        } else {
          if (msg.host && claimsHost) r.meta.host = String(msg.host).slice(0, 30);
          const joinMode = sanitizeGameMode(msg.gameMode);
          if (joinMode && claimsHost) {
            r.meta.gameMode = joinMode;
            r.meta.gameModeRevision = GAME_MODE_REVISIONS[joinMode] || 1;
          } else if (!r.meta.gameMode) {
            r.meta.gameMode = "free_drive";
            r.meta.gameModeRevision = 1;
          }
          if (msg.roomName) r.meta.roomName = String(msg.roomName).slice(0, 40);
          if (msg.capacity && claimsHost) r.meta.capacity = parseInt(msg.capacity, 10) || r.meta.capacity;
          if (msg.token && claimsHost) r.meta.token = String(msg.token);
          if (r.closed) {
            r.closed = false;
            recentlyClosed.delete(roomId);
          }
        }
        const installKeyOf = pid => {
          const seg = String(pid || "").split("-");
          return seg.length >= 2 ? seg[seg.length - 2] : String(pid || "");
        };
        const myKey = installKeyOf(playerId);
        for (const [oldSock, oldEnt] of r.sockets) {
          if (oldSock !== socket && installKeyOf(oldEnt.id) === myKey) {
            r.sockets.delete(oldSock);
            console.log(`[${roomId}] ghost entry removed: ${oldEnt.name} (${oldEnt.id})`);
          }
        }
        const cap = r.meta.capacity || 8;
        if (!r.sockets.has(socket) && r.sockets.size >= cap) {
          try {
            socket.write(JSON.stringify({
              type: "system",
              text: "房间已满",
              roomId: roomId
            }) + "\n");
          } catch (e) {}
          console.log(`[${roomId}] join rejected: room full (${r.sockets.size}/${cap})`);
          try {
            socket.end();
          } catch (e) {}
          setTimeout(() => {
            try {
              socket.destroy();
            } catch (e) {}
          }, 500);
          continue;
        }
        r.sockets.set(socket, {
          name: playerName,
          id: playerId,
          version: String(msg.version || "").slice(0, 16),
          isHost: claimsHost
        });
        if (claimsHost) r.hostLeftAt = 0;
        r.lastActive = Date.now();
        try {
          socket.write(JSON.stringify(Object.assign({
            type: "players"
          }, roomState(roomId))) + "\n");
        } catch (e) {}
        broadcast(roomId, {
          type: "system",
          text: `${playerName} 加入了游戏`
        }, socket);
        pushPlayerList(roomId);
        console.log(`[${roomId}] ${playerName} joined via ${via} (${r.sockets.size} players)`);
      } else if (roomId) {
        const r = rooms.get(roomId);
        if (r) r.lastActive = Date.now();
        if (msg.type === "ping") continue;
        if (msg.type === "close-room") {
          const res = closeRoom(roomId, msg.by, msg.token);
          console.log(`[${roomId}] close-room via tcp:`, JSON.stringify(res));
          continue;
        }
        if (msg.type === "set-game-mode") {
          const r2 = rooms.get(roomId);
          const mode = sanitizeGameMode(msg.gameMode);
          if (r2 && mode) {
            r2.meta.gameMode = mode;
            r2.meta.gameModeRevision = parseInt(msg.gameModeRevision, 10) || GAME_MODE_REVISIONS[mode] || 1;
            r2.lastActive = Date.now();
            pushPlayerList(roomId);
            console.log(`[${roomId}] game mode -> ${mode} (rev ${r2.meta.gameModeRevision})`);
          }
          continue;
        }
        if (msg.type === "set-capacity") {
          const r2 = rooms.get(roomId);
          const cap = Math.max(2, Math.min(16, parseInt(msg.capacity, 10) || 0));
          if (r2 && cap) {
            r2.meta.capacity = cap;
            r2.lastActive = Date.now();
            pushPlayerList(roomId);
            console.log(`[${roomId}] capacity -> ${cap}`);
          }
          continue;
        }
        if (msg.type === "query-players") {
          try {
            socket.write(JSON.stringify(Object.assign({
              type: "players"
            }, roomState(roomId))) + "\n");
          } catch (e) {}
          continue;
        }
        if (!FORWARD_TYPES.has(msg.type)) continue;
        if (SELF_ID_TYPES.has(msg.type)) {
          const me = r && r.sockets.get(socket);
          if (me && me.id) msg.id = me.id;
        }
        trackTelemetry(roomId, msg);
        broadcast(roomId, msg, socket);
      }
    }
  });
  socket.on("close", () => {
    leaveRoom();
  });
  socket.on("error", err => {
    if (err && err.code !== "ECONNRESET") console.error("Socket error:", err.message);
  });
}

function wsEncodeFrame(str, opcode) {
  const payload = Buffer.isBuffer(str) ? str : Buffer.from(str, "utf8");
  const len = payload.length;
  let hlen;
  if (len < 126) hlen = 2; else if (len < 65536) hlen = 4; else hlen = 10;
  const head = Buffer.alloc(hlen);
  head[0] = 128 | (opcode === undefined ? 1 : opcode);
  if (len < 126) {
    head[1] = len;
  } else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([ head, payload ]);
}

class WsSocket extends require("events").EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.destroyed = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;
  }
  write(str) {
    if (this.destroyed || this.socket.destroyed) return false;
    try {
      this.socket.write(wsEncodeFrame(str, 1));
      return true;
    } catch (e) {
      return false;
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.socket.write(wsEncodeFrame(Buffer.alloc(0), 8));
    } catch (e) {}
    try {
      this.socket.destroy();
    } catch (e) {}
  }
  feed(chunk) {
    this._buf = Buffer.concat([ this._buf, chunk ]);
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 128) !== 0;
      const opcode = b0 & 15;
      const masked = (b1 & 128) !== 0;
      let len = b1 & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const hi = buf.readUInt32BE(2);
        const lo = buf.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        off = 10;
      }
      if (len > 4 * 1024 * 1024) {
        this.destroy();
        return;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.slice(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      this._buf = buf.slice(off + len);
      if (masked && len > 0) {
        const p = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3];
        payload = p;
      }
      if (opcode === 8) {
        this.destroyed = true;
        this.emit("close");
        return;
      } else if (opcode === 9) {
        try {
          this.socket.write(wsEncodeFrame(payload, 10));
        } catch (e) {}
        continue;
      } else if (opcode === 10) {
        continue;
      } else if (opcode === 1 || opcode === 2) {
        if (fin) {
          this.emit("data", payload);
        } else {
          this._fragOpcode = opcode;
          this._fragments = [ payload ];
        }
      } else if (opcode === 0) {
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          this._fragments = [];
          this.emit("data", full);
        }
      }
    }
  }
}

function handleUpgrade(req, socket, head) {
  wsAccepted++;
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers["upgrade"] || "").toLowerCase() !== "websocket") {
    try {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch (e) {}
    try {
      socket.destroy();
    } catch (e) {}
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  const headers = [ "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + accept, "", "" ].join("\r\n");
  try {
    socket.write(headers);
  } catch (e) {
    try {
      socket.destroy();
    } catch (e2) {}
    return;
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15e3);
  socket.setTimeout(0);
  const ws = new WsSocket(socket);
  socket.on("data", c => {
    try {
      ws.feed(c);
    } catch (e) {
      ws.destroy();
    }
  });
  socket.on("close", () => {
    ws.destroyed = true;
    ws.emit("close");
  });
  socket.on("error", e => {
    ws.destroyed = true;
    ws.emit("error", e);
  });
  if (head && head.length) {
    try {
      ws.feed(head);
    } catch (e) {}
  }
  console.log(`[ws] tunnel opened from ${socket.remoteAddress} ${req.url}`);
  attachConnection(ws, "ws");
}

const server = net.createServer(socket => {
  tcpAccepted++;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15e3);
  attachConnection(socket, "tcp");
});

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => {
      b += c;
      if (b.length > 65536) b = "";
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

const BOARD_TTL_MS = 90 * 1e3;

const boardRooms = new Map;

const boardChats = new Map;

let ROOM_PROFILE = null;

if (process.env.SR_ROOM_CONFIG) {
  try {
    ROOM_PROFILE = JSON.parse(fs.readFileSync(process.env.SR_ROOM_CONFIG, "utf8"));
    console.log(`[board] room profile: ${ROOM_PROFILE.roomId} mode=${ROOM_PROFILE.gameMode} map=${ROOM_PROFILE.map} cap=${ROOM_PROFILE.capacity}`);
  } catch (e) {
    console.log("[board] room profile load failed:", e.message);
  }
}

function boardPurge() {
  const now = Date.now();
  for (const [id, e] of boardRooms) {
    if (!e.persistent && now - e.lastSeen > BOARD_TTL_MS) {
      boardRooms.delete(id);
      boardChats.delete(id);
    }
  }
}

if (ROOM_PROFILE) {
  const pid = String(ROOM_PROFILE.roomId || "SERVER");
  if (!boardRooms.has(pid)) {
    boardRooms.set(pid, {
      created: Date.now(),
      lastSeen: Date.now(),
      persistent: true,
      data: {
        id: pid,
        name: ROOM_PROFILE.name || "服务器房间",
        mode: ROOM_PROFILE.gameMode || "free_drive",
        gameMode: ROOM_PROFILE.gameMode || "free_drive",
        gameModeRevision: 1,
        map: ROOM_PROFILE.map || "west_coast_usa",
        spawn: ROOM_PROFILE.spawn || "",
        host: ROOM_PROFILE.hostName || "服务器",
        capacity: Number(ROOM_PROFILE.capacity) || 8,
        players: 0,
        live: true,
        persistent: true
      }
    });
    boardChats.set(pid, {
      list: [],
      latest: 0
    });
  }
}

async function handleBoardApi(req, res, path) {
  let p = path;
  if (p === "/api/startride" || p.startsWith("/api/startride/")) p = p.slice("/api/startride".length);
  if (p !== "/rooms" && !p.startsWith("/rooms/")) return false;
  boardPurge();
  if (p === "/rooms") {
    if (req.method === "GET") {
      for (const [, e] of boardRooms) {
        if (e.persistent) e.lastSeen = Date.now();
      }
      const list = [];
      for (const [, e] of boardRooms) {
        if (Date.now() - e.lastSeen <= BOARD_TTL_MS) {
          e.data.live = true;
          list.push(e.data);
        }
      }
      list.sort((a, b) => (b.created || 0) - (a.created || 0));
      sendJSON(res, 200, {
        code: 200,
        msg: "ok",
        data: list
      });
      return true;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body || !body.id) {
        sendJSON(res, 400, {
          code: 400,
          msg: "missing id"
        });
        return true;
      }
      const pid0 = ROOM_PROFILE ? String(ROOM_PROFILE.roomId || "SERVER") : "";
      if (pid0 && String(body.id) === pid0) {
        sendJSON(res, 400, {
          code: 400,
          msg: "reserved room id"
        });
        return true;
      }
      if (ROOM_PROFILE) {
        if (!body.gameMode) {
          body.gameMode = ROOM_PROFILE.gameMode || "free_drive";
          body.mode = body.gameMode;
        }
        if (!body.map) body.map = ROOM_PROFILE.map || "west_coast_usa";
        const cap = Number(ROOM_PROFILE.capacity) || 0;
        if (cap > 0 && (!body.capacity || Number(body.capacity) > cap)) body.capacity = cap;
      }
      const e = boardRooms.get(body.id) || {
        created: Date.now()
      };
      e.data = body;
      e.lastSeen = Date.now();
      boardRooms.set(String(body.id), e);
      if (!boardChats.has(String(body.id))) boardChats.set(String(body.id), {
        list: [],
        latest: 0
      });
      sendJSON(res, 200, {
        code: 200,
        msg: "ok",
        data: body
      });
      return true;
    }
  }
  const rest = p.slice("/rooms/".length);
  const segs = rest.split("/");
  const roomId = segs[0];
  const sub = segs[1] || "";
  if (roomId && sub === "") {
    const e = boardRooms.get(roomId);
    if (req.method === "DELETE") {
      boardRooms.delete(roomId);
      boardChats.delete(roomId);
      sendJSON(res, 200, {
        code: 200,
        msg: "ok"
      });
      return true;
    }
    if (req.method === "GET") {
      if (!e) {
        sendJSON(res, 200, {
          code: 404,
          msg: "not found",
          data: null
        });
        return true;
      }
      sendJSON(res, 200, {
        code: 200,
        msg: "ok",
        data: e.data
      });
      return true;
    }
  }
  if (roomId && req.method === "POST") {
    const e = boardRooms.get(roomId);
    if (sub === "heartbeat") {
      if (e) e.lastSeen = Date.now();
      sendJSON(res, 200, {
        code: 200,
        msg: "ok"
      });
      return true;
    }
    if (sub === "join" || sub === "leave") {
      const body = await readBody(req);
      if (e && e.data) {
        if (sub === "join") {
          e.data.players = (Number(e.data.players) || 1) + 1;
          if (body.player) {
            const pl = Array.isArray(e.data.playerList) ? e.data.playerList : [];
            if (!pl.includes(body.player)) pl.push(body.player);
            e.data.playerList = pl;
          }
        } else {
          e.data.players = Math.max(1, (Number(e.data.players) || 1) - 1);
          if (body.player && Array.isArray(e.data.playerList)) {
            e.data.playerList = e.data.playerList.filter(x => x !== body.player);
          }
        }
        e.lastSeen = Date.now();
      }
      sendJSON(res, 200, {
        code: 200,
        msg: "ok"
      });
      return true;
    }
  }
  if (roomId && sub === "chat" && (req.method === "POST" || req.method === "GET")) {
    if (!boardChats.has(roomId)) boardChats.set(roomId, {
      list: [],
      latest: 0
    });
    const c = boardChats.get(roomId);
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body && body.player && body.text) {
        c.latest += 1;
        c.list.push({
          id: c.latest,
          player: String(body.player),
          text: String(body.text),
          timestamp: Date.now()
        });
        if (c.list.length > 200) c.list.splice(0, c.list.length - 200);
      }
      sendJSON(res, 200, {
        code: 200,
        msg: "ok"
      });
      return true;
    }
    const since = parseInt(new URL(req.url, "http://localhost").searchParams.get("since") || "0", 10) || 0;
    sendJSON(res, 200, {
      code: 200,
      data: c.list.filter(m => m.id > since),
      latest: c.latest
    });
    return true;
  }
  sendJSON(res, 404, {
    code: 404,
    msg: "not found"
  });
  return true;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end();
    return;
  }
  if (path === "/health") {
    return sendJSON(res, 200, {
      ok: true,
      version: RELAY_VERSION,
      rooms: rooms.size,
      uptime: process.uptime(),
      wsTunnel: true,
      tcpAccepted: tcpAccepted,
      wsAccepted: wsAccepted
    });
  }
  if (path === "/live") {
    const out = {};
    for (const [id, r] of rooms) out[id] = roomState(id);
    const closedList = [];
    for (const [id, t] of recentlyClosed) {
      if (Date.now() - t > 10 * 60 * 1e3) recentlyClosed.delete(id); else closedList.push(id);
    }
    return sendJSON(res, 200, {
      ok: true,
      rooms: out,
      closed: closedList
    });
  }
  if (path === "/close" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.roomId) return sendJSON(res, 400, {
      ok: false,
      error: "missing roomId"
    });
    const r = closeRoom(String(body.roomId), body.by, body.token);
    return sendJSON(res, r.ok ? 200 : 400, r);
  }
  if (path === "/api/startride/live") {
    return sendJSON(res, 200, {
      ok: true,
      t: Date.now(),
      rooms: liveSnapshot()
    });
  }
  if (path === "/api/startride/servers" && req.method === "GET") {
    const now = Date.now();
    for (const [k, s] of registry) {
      if (now - s.lastSeen > REGISTRY_TTL_MS) registry.delete(k);
    }
    const list = [ {
      official: true,
      name: "StartRide 官方服务器",
      url: "",
      map: "",
      mode: "",
      players: -1,
      capacity: 0,
      lastSeen: now
    } ];
    for (const [, s] of registry) list.push(s);
    return sendJSON(res, 200, {
      ok: true,
      t: now,
      servers: list
    });
  }
  if (path === "/api/startride/servers/register" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !body.url) return sendJSON(res, 400, {
      ok: false,
      error: "missing url"
    });
    const now = Date.now();
    const key = String(body.url).slice(0, 200).trim();
    if (!/^http:\/\//.test(key)) return sendJSON(res, 400, {
      ok: false,
      error: "bad url"
    });
    const prev = registry.get(key);
    if (prev && now - prev.lastSeen < 3e4) {
      return sendJSON(res, 429, {
        ok: false,
        error: "too frequent"
      });
    }
    if (!registry.has(key) && registry.size >= 100) {
      return sendJSON(res, 400, {
        ok: false,
        error: "registry full"
      });
    }
    registry.set(key, {
      name: String(body.name || "StartRide 服务器").slice(0, 48),
      url: key,
      map: String(body.map || "").slice(0, 32),
      mode: String(body.mode || "").slice(0, 24),
      players: Math.max(0, parseInt(body.players, 10) || 0),
      capacity: Math.max(0, parseInt(body.capacity, 10) || 0),
      version: String(body.version || "").slice(0, 16),
      lastSeen: now
    });
    return sendJSON(res, 200, {
      ok: true
    });
  }
  if (await handleBoardApi(req, res, path)) return;
  sendJSON(res, 404, {
    ok: false,
    error: "not found"
  });
});

httpServer.on("upgrade", handleUpgrade);

server.listen(TCP_PORT, "0.0.0.0", () => {
  console.log(`[${(new Date).toISOString()}] StartRide relay listening on 0.0.0.0:${TCP_PORT} (game data)`);
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[${(new Date).toISOString()}] StartRide relay control API + ws tunnel on ${HTTP_HOST}:${HTTP_PORT}`);
});

const REGISTRY_URL = process.env.SR_REGISTRY === "0" ? "" : process.env.SR_REGISTRY_URL || "https://startride.top/api/startride/servers/register";

const PUBLIC_URL = String(process.env.SR_PUBLIC_URL || "").trim();

function registryBeat() {
  if (!REGISTRY_URL || !PUBLIC_URL) return;
  let count = 0;
  for (const [, r] of rooms) count += r.sockets.size;
  let name = "", mode = "", map = "", capacity = 0;
  if (typeof ROOM_PROFILE !== "undefined" && ROOM_PROFILE) {
    name = ROOM_PROFILE.name || "";
    mode = ROOM_PROFILE.gameMode || "";
    map = ROOM_PROFILE.map || "";
    capacity = Number(ROOM_PROFILE.capacity) || 0;
  } else {
    for (const [, r] of rooms) {
      name = r.meta && (r.meta.roomName || r.meta.name) || name;
      mode = r.meta && r.meta.gameMode || mode;
      capacity = r.meta && r.meta.capacity || capacity;
      break;
    }
  }
  const body = JSON.stringify({
    name: name || "StartRide 服务器",
    url: PUBLIC_URL,
    map: map,
    mode: mode,
    players: count,
    capacity: capacity,
    version: RELAY_VERSION
  });
  try {
    const u = new URL(REGISTRY_URL);
    const mod = u.protocol === "https:" ? https : http;
    const req2 = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 1e4
    }, res2 => {
      res2.resume();
    });
    req2.on("error", () => {});
    req2.on("timeout", () => req2.destroy());
    req2.end(body);
  } catch (e) {}
}

if (REGISTRY_URL && PUBLIC_URL) {
  setTimeout(registryBeat, 5e3).unref();
  setInterval(registryBeat, 6e4).unref();
}

setInterval(() => {
  for (const [id, r] of rooms) {
    pushPlayerList(id);
    if (Date.now() - r.lastActive > ROOM_TTL_MS && r.sockets.size === 0) {
      rooms.delete(id);
      continue;
    }
    let hasHost = false;
    for (const [, info] of r.sockets) {
      if (info.isHost) {
        hasHost = true;
        break;
      }
    }
    if (r.hostLeftAt && !hasHost && r.sockets.size > 0 && Date.now() - r.hostLeftAt > HOST_GRACE_MS) {
      const res = closeRoom(id, r.meta.host, r.meta.token, "房主已离开，联机已结束");
      console.log(`[${id}] host gone > ${HOST_GRACE_MS}ms -> closed:`, JSON.stringify(res));
    }
  }
}, PLAYER_LIST_INTERVAL);

setInterval(() => {
  for (const [, r] of rooms) {
    const data = JSON.stringify({
      type: "ping"
    }) + "\n";
    for (const [s] of r.sockets) {
      if (!s.destroyed) {
        try {
          s.write(data);
        } catch (e) {}
      }
    }
  }
}, IDLE_PING_INTERVAL);