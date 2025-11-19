function getBaseUrl(req){ return `${req.protocol}://${req.get('host')}`; }
export function renderScriptsPage(req, pass, csrf, scriptsList){
  const baseUrl = getBaseUrl(req);
  const tiles = (scriptsList || []).map((s) => {
    const name = s.name || "Untitled";
    const desc = s.description || "";
    const preview = String(s.originalCode || s.content || '').slice(0, 120).replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const publicUrl = `${baseUrl}/s/${s.publicToken || ''}`;
    const copySnippet = `loadstring(game:HttpGet("${publicUrl}"))()`
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `
      <div class="glass rounded-xl p-4 border border-slate-700/50 ${s.isActive ? 'ring-1 ring-emerald-500/30' : ''}">
        <div class="flex items-center justify-between mb-2">
          <div>
            <h3 class="text-sm font-semibold">${name}</h3>
            <p class="text-xs text-slate-400">${desc}</p>
          </div>
          <span class="px-2 py-0.5 rounded text-xs ${s.isActive ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'}">${s.isActive ? 'Enabled' : 'Disabled'}</span>
        </div>
        <pre class="text-[11px] bg-slate-950/40 border border-slate-700 rounded-lg p-2 font-mono overflow-x-auto">${preview}...</pre>
        <div class="mt-3 flex flex-wrap gap-2">
          <button onclick="openEdit('${s._id}','${encodeURIComponent(name)}','${encodeURIComponent(desc)}')" class="px-3 py-1.5 rounded bg-blue-500/10 text-blue-300 text-xs border border-blue-500/20">Редактировать</button>
          <form method="POST" action="/admin/script-action" class="inline" onsubmit="return confirm('Удалить скрипт?')">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="delete">
            <button class="px-3 py-1.5 rounded bg-rose-500/10 text-rose-300 text-xs border border-rose-500/20">Удалить</button>
          </form>
          ${s.isActive ? `
          <form method="POST" action="/admin/script-action" class="inline" onsubmit="return confirm('Отключить скрипт?')">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="deactivate">
            <button class="px-3 py-1.5 rounded bg-amber-500/10 text-amber-300 text-xs border border-amber-500/20">Отключить</button>
          </form>
          ` : `
          <form method="POST" action="/admin/script-action" class="inline">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="id" value="${s._id}">
            <input type="hidden" name="action" value="activate">
            <button class="px-3 py-1.5 rounded bg-emerald-500/10 text-emerald-300 text-xs border border-emerald-500/20">Включить</button>
          </form>
          `}
          <button onclick="copyLoadstring(this)" data-loadstring="${copySnippet}" class="px-3 py-1.5 rounded bg-indigo-500/10 text-indigo-300 text-xs border border-indigo-500/20">Копировать loadstring</button>
        </div>
      </div>
    `;
  }).join("");
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Scripts</h1>
          <p class="text-sm text-slate-400">Manage Roblox executor scripts</p>
        </div>
        <button onclick="openCreate()" class="btn btn-primary">Создать скрипт</button>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${tiles || '<div class="glass rounded-xl p-6 text-slate-400">Нет скриптов</div>'}
      </div>
    </div>
  `;
}