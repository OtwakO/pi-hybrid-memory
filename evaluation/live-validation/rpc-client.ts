import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class PiRpcClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: RpcEvent[] = [];
  private sequence = 0;
  private stderr = "";

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.process = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.attachReader(this.process.stdout, line => this.handleLine(line));
    this.process.stderr.on("data", chunk => { this.stderr += chunk.toString(); });
    this.process.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") return;
      const error = new Error(`Pi RPC exited (${code ?? signal}): ${this.stderr.trim()}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
    });
  }

  private attachReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", chunk => {
      buffer += decoder.write(chunk as Buffer);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) onLine(line);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  private handleLine(line: string): void {
    let value: RpcEvent | RpcResponse;
    try {
      value = JSON.parse(line) as RpcEvent | RpcResponse;
    } catch {
      this.events.push({ type: "invalid-json", line });
      return;
    }
    if (value.type === "response" && typeof value.id === "string") {
      const response = value as RpcResponse;
      const request = this.pending.get(response.id!);
      if (request) {
        clearTimeout(request.timeout);
        this.pending.delete(response.id!);
        request.resolve(response);
        return;
      }
    }
    this.events.push(value as RpcEvent);
  }

  async request<T>(command: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    const id = `live-${++this.sequence}`;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${String(command.type)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
    if (!response.success) throw new Error(response.error ?? `Pi RPC ${response.command} failed`);
    return response.data as T;
  }

  observedEvents(): readonly RpcEvent[] {
    return this.events;
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 5_000);
      this.process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
