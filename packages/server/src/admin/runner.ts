import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface LogLine {
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export type RunnerStatus = "idle" | "running" | "done" | "error";

const MAX_LINES = 1000;

export class ScraperRunner {
  #lines: LogLine[] = [];
  #status: RunnerStatus = "idle";
  #exitCode: number | null = null;
  #startedAt: number | null = null;
  #process: ChildProcess | null = null;

  get status(): RunnerStatus {
    return this.#status;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get startedAt(): number | null {
    return this.#startedAt;
  }

  tail(n = 100): LogLine[] {
    return this.#lines.slice(-n);
  }

  addSystemMessage(text: string): void {
    this.#push("system", text);
  }

  #push(stream: LogLine["stream"], text: string): void {
    if (this.#lines.length >= MAX_LINES) {
      this.#lines.shift();
    }
    this.#lines.push({ ts: Date.now(), stream, text });
  }

  run(scraperEntrypoint: string, env?: Record<string, string>): Promise<void> {
    if (this.#status === "running") {
      return Promise.reject(new Error("Scraper is already running"));
    }

    this.#lines = [];
    this.#status = "running";
    this.#exitCode = null;
    this.#startedAt = Date.now();

    this.#push("system", `Starting scraper: node ${scraperEntrypoint}`);

    const child = spawn("node", [scraperEntrypoint], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.#process = child;

    const rl_out = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rl_err = createInterface({ input: child.stderr, crlfDelay: Infinity });

    rl_out.on("line", (line) => this.#push("stdout", line));
    rl_err.on("line", (line) => this.#push("stderr", line));

    const done = new Promise<void>((resolve, reject) => {
      child.on("close", (code, signal) => {
        this.#process = null;
        this.#exitCode = code ?? null;

        if (signal) {
          this.#status = "error";
          this.#push("system", `Process killed by signal: ${signal}`);
          reject(new Error(`Process killed: ${signal}`));
        } else if (code === 0) {
          this.#status = "done";
          this.#push("system", `Process exited successfully (code 0)`);
          resolve();
        } else {
          this.#status = "error";
          this.#push("system", `Process exited with code ${String(code)}`);
          reject(new Error(`Process exited with code ${String(code)}`));
        }
      });

      child.on("error", (err) => {
        this.#process = null;
        this.#status = "error";
        this.#push("system", `Failed to start process: ${err.message}`);
        reject(err);
      });
    });

    // Fire-and-forget: caller may or may not await
    done.catch(() => {
      // Status already set in close handler; prevent unhandled rejection
    });

    return done;
  }

  kill(): void {
    if (this.#process) {
      this.#push("system", "Kill signal sent to scraper process");
      this.#process.kill("SIGTERM");
    }
  }
}

export const scraperRunner = new ScraperRunner();
