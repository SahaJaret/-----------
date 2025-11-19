export function renderOverviewPage(pass, rangeDays, clicks, checkpoints, totalKeys, keysGenerated, keysUsed, scriptExecutions, totalChecks, list, series = {}, growth = {}){
  const rows = list.slice(0, 10).map((item) => {
    const expired = item.expiresAt && item.expiresAt < new Date();
    const expStr = item.expiresAt ? item.expiresAt.toISOString().slice(0, 19).replace("T", " ") : "—";
    const createdStr = item.createdAt ? item.createdAt.toISOString().slice(0, 19).replace("T", " ") : "—";

    return `
    <tr class="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
      <td class="px-4 py-3">
        <div class="font-mono text-sm font-semibold text-blue-300">${item.key}</div>
      </td>
      <td class="px-4 py-3 text-slate-400 text-sm">${createdStr}</td>
      <td class="px-4 py-3 ${expired ? "text-rose-300" : "text-slate-300"} text-sm">${expStr}</td>
      <td class="px-4 py-3">
        ${item.isActive 
           ? '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>' 
           : '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 text-slate-300 border border-slate-500/20">Disabled</span>'}
      </td>
      <td class="px-4 py-3 text-slate-300 text-sm">${item.usageCount || 0}${item.maxUsage ? ('/'+item.maxUsage) : ''}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${item.robloxUsername || '—'}</td>
      <td class="px-4 py-3 text-slate-300 text-sm">${item.source || '—'}</td>
      <td class="px-4 py-3">
        <div class="flex gap-2">
          <a href="/admin/delete-key?pass=${pass}&key=${encodeURIComponent(item.key)}" class="btn btn-outline-rose">Delete</a>
        </div>
      </td>
    </tr>`;
  }).join("");

  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Statistics — ${rangeDays} days</h1>
          <p class="text-sm text-slate-400">Clicks, checkpoints, keys</p>
        </div>
        <div class="flex gap-2">
          <a href="/admin?pass=${pass}&page=overview&range=7" class="px-3 py-1.5 rounded-lg ${rangeDays === 7 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium">7</a>
          <a href="/admin?pass=${pass}&page=overview&range=14" class="px-3 py-1.5 rounded-lg ${rangeDays === 14 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium">14</a>
          <a href="/admin?pass=${pass}&page=overview&range=30" class="px-3 py-1.5 rounded-lg ${rangeDays === 30 ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30" : "glass text-slate-300 hover:text-white"} text-sm font-medium">30</a>
        </div>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-4">
        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m4 0h-1V8h-1m4 8h-1v-2h-1"/></svg>
            </div>
            <span class="text-xs text-emerald-300">${(growth.clicks ?? 0) >= 0 ? '▲' : '▼'} ${Math.abs(growth.clicks ?? 0).toFixed(1)}%</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Clicks</p>
          <p class="text-3xl font-bold text-blue-300">${clicks}</p>
          <canvas id="spark-clicks" height="40"></canvas>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <span class="text-xs text-emerald-300">${(growth.checkpoints ?? 0) >= 0 ? '▲' : '▼'} ${Math.abs(growth.checkpoints ?? 0).toFixed(1)}%</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Checkpoints</p>
          <p class="text-3xl font-bold text-emerald-300">${checkpoints}</p>
          <canvas id="spark-checkpoints" height="40"></canvas>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5l7 7-7 7-7-7V7a4 4 0 014-4z"/></svg>
            </div>
            <span class="text-xs text-slate-500">total</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Keys</p>
          <p class="text-3xl font-bold text-amber-300">${totalKeys}</p>
          <canvas id="spark-keys" height="40"></canvas>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Keys generated</p>
          <p class="text-3xl font-bold text-purple-300">${keysGenerated}</p>
          <canvas id="spark-generated" height="40"></canvas>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-sky-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7"/></svg>
            </div>
            <span class="text-xs text-slate-500">rate</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Keys used</p>
          <p class="text-3xl font-bold text-sky-300">${keysUsed}</p>
          <div class="mt-2 h-2 w-full bg-slate-800/50 rounded-full">
            <div class="h-2 rounded-full bg-sky-500" style="width:${series.usageRate ?? 0}%"></div>
          </div>
          <canvas id="spark-used" height="40"></canvas>
        </div>

        <div class="stat-card">
          <div class="flex items-center justify-between mb-3">
            <div class="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center">
              <svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/></svg>
            </div>
            <span class="text-xs text-slate-500">${rangeDays}d</span>
          </div>
          <p class="text-xs text-slate-400 mb-1 font-medium">Script executions</p>
          <p class="text-3xl font-bold text-rose-300">${scriptExecutions}</p>
          <canvas id="spark-exec" height="40"></canvas>
        </div>
      </div>

      <div class="glass rounded-xl p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Overview</h2>
          <div class="text-xs text-slate-400">Clicks, Checkpoints, Keys</div>
        </div>
        <canvas id="overview-chart" height="260"></canvas>
        <script>
          (function(){
            var s = ${JSON.stringify(series || {})};
            function line(ctx, data, color){
              var w = ctx.canvas.width, h = ctx.canvas.height; var max = Math.max.apply(null, data.concat([1])); var stepX = w / Math.max(1, data.length-1); ctx.clearRect(0,0,w,h); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); for(var i=0;i<data.length;i++){ var x=i*stepX; var y=h - (data[i]/max)*h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.stroke(); }
            function spark(id, data, color){ var c=document.getElementById(id); if(!c||!data) return; var ctx=c.getContext('2d'); line(ctx, data, color); }
            spark('spark-clicks', s.clicks, '#60a5fa');
            spark('spark-checkpoints', s.checkpoints, '#34d399');
            spark('spark-keys', s.keys, '#f59e0b');
            spark('spark-generated', s.generated, '#a78bfa');
            spark('spark-used', s.used, '#38bdf8');
            spark('spark-exec', s.exec, '#f43f5e');
            var oc=document.getElementById('overview-chart'); if(oc){ var octx=oc.getContext('2d'); var w=oc.width, h=oc.height; octx.clearRect(0,0,w,h); function drawGrid(){ octx.strokeStyle='rgba(148,163,184,0.15)'; octx.lineWidth=1; for(var i=0;i<5;i++){ var y=i*(h/4); octx.beginPath(); octx.moveTo(0,y); octx.lineTo(w,y); octx.stroke(); } } drawGrid(); line(octx, s.clicks||[], '#60a5fa'); line(octx, s.checkpoints||[], '#34d399'); line(octx, s.keys||[], '#f59e0b'); }
          })();
        </script>
      </div>

      <div class="glass rounded-xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold">Recent Keys</h2>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr>
                <th class="px-4 py-3 text-left font-semibold">Key</th>
                <th class="px-4 py-3 text-left font-semibold">Created</th>
                <th class="px-4 py-3 text-left font-semibold">Expires</th>
                <th class="px-4 py-3 text-left font-semibold">Status</th>
                <th class="px-4 py-3 text-left font-semibold">Usage</th>
                <th class="px-4 py-3 text-left font-semibold">Roblox</th>
                <th class="px-4 py-3 text-left font-semibold">Source</th>
                <th class="px-4 py-3 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/30">
              ${rows || '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">No keys found</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}