import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  createHostBridgeServer,
  type HostBridgeConnection,
  type HostBridgeServer,
  type HostBridgeServerOptions,
} from "./index.js";

export interface LoopbackHostBridgeOptions extends HostBridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxFrameBytes?: number;
}

export interface LoopbackHostBridge {
  readonly bridge: HostBridgeServer;
  readonly server: Server;
  readonly address: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Minimal dependency-free WebSocket server for the loopback Node Host.
 * It deliberately accepts only text frames and passes only HostBridge
 * messages to the protocol server; no HTTP route, file, shell, or proxy is
 * exposed by this module.
 */
export function createLoopbackHostBridge(options: LoopbackHostBridgeOptions): LoopbackHostBridge {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("HostBridge must bind to loopback");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("HostBridge port is invalid");
  const maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
  const bridge = createHostBridgeServer(options);
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    const tcpSocket = socket as Socket;
    if (
      !isLoopbackAddress(tcpSocket.remoteAddress) ||
      !isOriginAllowed(request, options.allowedOrigins)
    ) {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || request.headers["sec-websocket-version"] !== "13") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = new NodeWebSocketConnection(
      tcpSocket,
      request.headers.origin ?? "",
      maxFrameBytes,
      head,
    );
    bridge.accept(connection);
  });
  return {
    bridge,
    server,
    address: `ws://${host}:${port}`,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise((resolve, reject) => {
        bridge.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

class NodeWebSocketConnection implements HostBridgeConnection {
  readonly origin: string;
  readonly loopback = true;
  readonly #socket: Socket;
  readonly #maxFrameBytes: number;
  readonly #messages = new Set<(data: string) => void>();
  readonly #closes = new Set<() => void>();
  #buffer: Buffer;
  #fragmentOpcode: 0x1 | undefined;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #closed = false;
  #closeNotified = false;
  constructor(socket: Socket, origin: string, maxFrameBytes: number, head: Buffer) {
    this.#socket = socket;
    this.origin = origin;
    this.#maxFrameBytes = maxFrameBytes;
    this.#buffer = Buffer.from(head);
    socket.on("data", (chunk) => this.#onData(Buffer.from(chunk)));
    socket.on("close", () => this.#emitClose());
    socket.on("error", () => this.#emitClose());
    if (this.#buffer.byteLength > 0) setTimeout(() => this.#parse(), 0);
  }
  get bufferedAmount(): number {
    return this.#socket.writableLength;
  }
  send(data: string): void {
    if (this.#closed) return;
    const payload = Buffer.from(data, "utf8");
    if (payload.byteLength > this.#maxFrameBytes) {
      this.close();
      return;
    }
    this.#socket.write(frame(payload, 0x1));
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end(frame(Buffer.alloc(0), 0x8));
    this.#emitClose();
  }
  onMessage(listener: (data: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }
  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > this.#maxFrameBytes * 2) {
      this.close();
      return;
    }
    this.#parse();
  }
  #parse(): void {
    while (this.#buffer.byteLength >= 2 && !this.#closed) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) {
        this.close();
        return;
      }
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.byteLength < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10 || this.#buffer.readUInt32BE(2) !== 0) {
          this.close();
          return;
        }
        length = this.#buffer.readUInt32BE(6);
        offset = 10;
      }
      if (
        !masked ||
        length > this.#maxFrameBytes ||
        this.#buffer.byteLength < offset + 4 + length
      ) {
        this.close();
        return;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        this.close();
        return;
      }
      const mask = this.#buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      this.#buffer = this.#buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1)
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      if (opcode === 0x8) {
        if (!validClosePayload(payload)) {
          this.close();
          return;
        }
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.#socket.write(frame(payload, 0xa));
        continue;
      }
      if (opcode === 0xa) continue;
      if (control || (opcode !== 0x0 && opcode !== 0x1)) {
        this.close();
        return;
      }
      if (opcode === 0x1) {
        if (this.#fragmentOpcode !== undefined) {
          this.close();
          return;
        }
        if (!fin) {
          this.#fragmentOpcode = 0x1;
          this.#fragments = [payload];
          this.#fragmentBytes = payload.byteLength;
          continue;
        }
        if (!this.#emitText(payload)) return;
        continue;
      }
      if (this.#fragmentOpcode === undefined) {
        this.close();
        return;
      }
      if (this.#fragmentBytes + payload.byteLength > this.#maxFrameBytes) {
        this.close();
        return;
      }
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.byteLength;
      if (fin) {
        const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
        this.#fragmentOpcode = undefined;
        this.#fragments = [];
        this.#fragmentBytes = 0;
        if (!this.#emitText(message)) return;
      }
    }
  }
  #emitText(payload: Buffer): boolean {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      this.close();
      return false;
    }
    for (const listener of this.#messages) {
      try {
        listener(text);
      } catch {
        this.close();
        return false;
      }
    }
    return true;
  }
  #emitClose(): void {
    if (this.#closeNotified) return;
    this.#closed = true;
    this.#closeNotified = true;
    for (const listener of this.#closes) listener();
    this.#closes.clear();
  }
}

function validClosePayload(payload: Buffer): boolean {
  if (payload.byteLength === 1) return false;
  if (payload.byteLength < 2) return true;
  const code = payload.readUInt16BE(0);
  if (
    code < 1_000 ||
    code >= 5_000 ||
    code === 1_004 ||
    code === 1_005 ||
    code === 1_006 ||
    code === 1_015
  )
    return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
    return true;
  } catch {
    return false;
  }
}

function frame(payload: Buffer, opcode: number): Buffer {
  if (payload.byteLength < 126)
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.byteLength]), payload]);
  if (payload.byteLength <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(payload.byteLength, 6);
  return Buffer.concat([header, payload]);
}
function isLoopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1";
}
function isLoopbackAddress(value: string | undefined): boolean {
  return value !== undefined && (isLoopback(value) || value === "::ffff:127.0.0.1");
}
function isOriginAllowed(request: IncomingMessage, origins: readonly string[]): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origins.includes(origin);
}
