export function renderLogin(){
  return `
  <!doctype html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root { --bg-1:#0f172a; --bg-2:#1e1b4b; --bg-3:#312e81; --bg-4:#1e293b; --surface: rgba(15,23,42,0.72); --border: rgba(148,163,184,0.12); }
      @keyframes gradient { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
      body { background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-4)); background-size: 400% 400%; animation: gradient 15s ease infinite; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; }
      .glass { background: var(--surface); backdrop-filter: blur(20px); border: 1px solid var(--border); }
    </style>
  </head>
  <body class="min-h-screen flex items-center justify-center text-white">
    <div class="glass rounded-2xl p-8 w-full max-w-md">
      <h1 class="text-2xl font-semibold mb-4">Admin Login</h1>
      <form method="GET" action="/admin" class="space-y-4">
        <div>
          <label class="block text-sm text-slate-300 mb-2">Password</label>
          <input name="pass" type="password" required class="input" placeholder="Enter admin password" />
        </div>
        <button class="btn btn-primary w-full">Sign In</button>
      </form>
      <p class="text-center text-slate-500 text-sm mt-6">Protected by enterprise-grade security</p>
    </div>
  </body>
  </html>`;
}