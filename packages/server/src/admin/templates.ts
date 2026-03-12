export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const NAV_LINKS = [
  { href: "/admin", label: "Dashboard", key: "dashboard" },
  { href: "/admin/health", label: "Health", key: "health" },
  { href: "/admin/jobs", label: "Jobs", key: "jobs" },
  { href: "/admin/retrieval", label: "Retrieval", key: "retrieval" },
  { href: "/admin/evals", label: "Eval/Ops", key: "evals" },
  { href: "/admin/controls", label: "Controls", key: "controls" },
  { href: "/admin/search", label: "Search", key: "search" },
  { href: "/admin/quality", label: "Quality", key: "quality" },
  { href: "/admin/scraper", label: "Scraper", key: "scraper" },
] as const;

export function page(title: string, body: string, activeNav?: string): string {
  const navItems = NAV_LINKS.map(({ href, label, key }) => {
    const isActive = key === activeNav;
    return `<a href="${href}" class="${
      isActive
        ? "text-white border-b-2 border-sky-400 pb-0.5"
        : "text-slate-400 hover:text-slate-200 transition-colors"
    } text-sm font-medium tracking-wide">${escapeHtml(label)}</a>`;
  }).join("\n      ");

  return `<!doctype html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — WP Admin</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📖</text></svg>" />
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <script src="https://unpkg.com/htmx.org@2" defer></script>
  <style type="text/tailwindcss">
    @theme {
      --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    }
  </style>
</head>
<body class="h-full bg-slate-950 text-slate-100 antialiased">

  <!-- Top navigation -->
  <header class="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
      <div class="flex items-center gap-8">
        <a href="/admin" class="flex items-center gap-2.5 group">
          <span class="text-xl">📖</span>
          <span class="font-semibold text-slate-200 group-hover:text-white transition-colors text-sm tracking-tight">WP Know It All</span>
          <span class="text-slate-600 text-xs font-medium px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">Admin</span>
        </a>
        <nav class="flex items-center gap-6">
          ${navItems}
        </nav>
      </div>
      <form action="/admin/logout" method="POST">
        <button type="submit" class="text-xs text-slate-500 hover:text-slate-300 transition-colors">Sign out</button>
      </form>
    </div>
  </header>

  <!-- Page content -->
  <main class="max-w-7xl mx-auto px-6 py-8">
    ${body}
  </main>

</body>
</html>`;
}

export function statCard(
  label: string,
  value: string | number,
  color = "sky"
): string {
  const colorMap: Record<string, string> = {
    sky: "text-sky-400",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    rose: "text-rose-400",
    violet: "text-violet-400",
    slate: "text-slate-400",
  };
  const textColor = colorMap[color] ?? "text-sky-400";

  return `<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col gap-2">
  <span class="text-xs font-medium text-slate-500 uppercase tracking-widest">${escapeHtml(label)}</span>
  <span class="text-3xl font-bold ${textColor} tabular-nums leading-none">${escapeHtml(String(value))}</span>
</div>`;
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<div class="text-center py-12 text-slate-500 text-sm">No records found.</div>`;
  }

  const headerCells = headers
    .map(
      (h) =>
        `<th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">${escapeHtml(h)}</th>`
    )
    .join("\n");

  const bodyRows = rows
    .map(
      (row, i) =>
        `<tr class="${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"} hover:bg-slate-800/60 transition-colors">
      ${row.map((cell) => `<td class="px-4 py-3 text-sm text-slate-300 whitespace-nowrap">${cell}</td>`).join("\n      ")}
    </tr>`
    )
    .join("\n    ");

  return `<div class="overflow-x-auto rounded-xl border border-slate-800">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-slate-800">
        ${headerCells}
      </tr>
    </thead>
    <tbody class="divide-y divide-slate-800/50">
      ${bodyRows}
    </tbody>
  </table>
</div>`;
}

export function statusBadge(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-400/10 text-amber-300 border border-amber-400/20">
  <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
  Running
</span>`;
    case "completed":
    case "done":
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-400/10 text-emerald-300 border border-emerald-400/20">
  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
  ${escapeHtml(status.charAt(0).toUpperCase() + status.slice(1))}
</span>`;
    case "failed":
    case "error":
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-400/10 text-rose-300 border border-rose-400/20">
  <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
  ${escapeHtml(status.charAt(0).toUpperCase() + status.slice(1))}
</span>`;
    case "idle":
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-400/10 text-slate-400 border border-slate-700">
  <span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
  Idle
</span>`;
    default:
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-400/10 text-slate-400 border border-slate-700">
  <span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
  ${escapeHtml(status)}
</span>`;
  }
}

export function logLine(line: {
  ts: number;
  stream: string;
  text: string;
}): string {
  const time = new Date(line.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const streamColors: Record<string, string> = {
    stdout: "text-slate-400",
    stderr: "text-rose-400",
    system: "text-sky-400",
  };
  const streamColor = streamColors[line.stream] ?? "text-slate-400";

  const textColor =
    line.stream === "stderr"
      ? "text-rose-300"
      : line.stream === "system"
        ? "text-sky-300"
        : "text-slate-300";

  return `<div class="flex gap-3 py-0.5 hover:bg-slate-800/40 px-2 -mx-2 rounded">
  <span class="text-slate-600 font-mono text-xs shrink-0 pt-px">${escapeHtml(time)}</span>
  <span class="${streamColor} font-mono text-xs w-10 shrink-0 pt-px">${escapeHtml(line.stream)}</span>
  <span class="${textColor} font-mono text-xs break-all">${escapeHtml(line.text)}</span>
</div>`;
}

export function loginPage(error?: string): string {
  const errorHtml = error
    ? `<div class="mb-5 px-4 py-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm">${escapeHtml(error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign In — WP Admin</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📖</text></svg>" />
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="h-full bg-slate-950 text-slate-100 antialiased flex items-center justify-center">
  <div class="w-full max-w-sm px-6">

    <div class="mb-10 text-center">
      <span class="text-4xl block mb-4">📖</span>
      <h1 class="text-xl font-semibold text-slate-100">WP Know It All</h1>
      <p class="text-sm text-slate-500 mt-1">Admin Dashboard</p>
    </div>

    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-black/50">
      ${errorHtml}
      <form action="/admin/login" method="POST" class="space-y-5">
        <div>
          <label for="password" class="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            autofocus
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600
                   focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-colors"
            placeholder="Enter password"
          />
        </div>
        <button
          type="submit"
          class="w-full bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>

    <p class="text-center text-xs text-slate-600 mt-6">
      Session expires after 8 hours
    </p>
  </div>
</body>
</html>`;
}
