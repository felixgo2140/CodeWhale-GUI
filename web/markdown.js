(function(){
  function escapeHtml(s){
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function sanitizeHtml(html){
    const allowed = new Set(["A","BLOCKQUOTE","BR","CODE","DEL","EM","H1","H2","H3","H4","HR","LI","OL","P","PRE","STRONG","TABLE","TBODY","TD","TH","THEAD","TR","UL"]);
    const drop = new Set(["EMBED","IFRAME","LINK","META","OBJECT","SCRIPT","STYLE","SVG","FORM","INPUT","BUTTON","TEXTAREA","SELECT","DETAILS","SUMMARY"]);
    const template = document.createElement("template");
    template.innerHTML = html || "";
    const visit = root => {
      Array.from(root.children || []).forEach(el => {
        if(drop.has(el.tagName)){
          el.remove();
          return;
        }
        if(!allowed.has(el.tagName)){
          el.replaceWith(...Array.from(el.childNodes));
          visit(root);
          return;
        }
        Array.from(el.attributes).forEach(attr => {
          const name = attr.name.toLowerCase();
          if(el.tagName === "A" && (name === "href" || name === "target" || name === "rel")){
            if(name === "href"){
              try{
                const u = new URL(el.getAttribute("href") || "", location.href);
                if(u.protocol !== "http:" && u.protocol !== "https:") el.removeAttribute("href");
              }catch(e){ el.removeAttribute("href"); }
            }
          }else el.removeAttribute(attr.name);
        });
        if(el.tagName === "A"){
          if(el.hasAttribute("href")){
            el.setAttribute("target","_blank");
            el.setAttribute("rel","noopener noreferrer");
          }else{
            el.removeAttribute("target");
            el.removeAttribute("rel");
          }
        }
        visit(el);
      });
    };
    visit(template.content);
    return template.innerHTML;
  }

  function md(text){
    text = String(text || "").replace(/\r\n/g,"\n");
    const fences = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code){
      fences.push("<pre><code>" + escapeHtml(code.replace(/\n+$/,"")) + "</code></pre>");
      return "\n[[CWF" + (fences.length - 1) + "]]\n";
    });
    const inline = function(s){
      return escapeHtml(s)
        .replace(/`([^`\n]+)`/g, function(m, c){ return "<code>" + c + "</code>"; })
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w])/g, "$1<em>$2</em>")
        .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    };
    const lines = text.split("\n"), out = [];
    let i = 0;
    const fence = l => /^\[\[CWF(\d+)\]\]$/.exec(l);
    while(i < lines.length){
      const l = lines[i], f = fence(l);
      if(f){ out.push(fences[+f[1]]); i++; continue; }
      if(!l.trim()){ i++; continue; }
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if(h){ const lv = Math.min(h[1].length,4); out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"); i++; continue; }
      if(/^(\s*[-*_]){3,}\s*$/.test(l)){ out.push("<hr>"); i++; continue; }
      if(/^\s*>\s?/.test(l)){
        const q = [];
        while(i < lines.length && /^\s*>\s?/.test(lines[i])){ q.push(lines[i].replace(/^\s*>\s?/,"")); i++; }
        out.push("<blockquote>" + inline(q.join("\n")).replace(/\n/g,"<br>") + "</blockquote>");
        continue;
      }
      if(/\|/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])){
        const parseRow = r => r.replace(/^\s*\|/,"").replace(/\|\s*$/,"").split("|").map(c => c.trim());
        const head = parseRow(l);
        i += 2;
        const rows = [];
        while(i < lines.length && /\|/.test(lines[i]) && lines[i].trim()){ rows.push(parseRow(lines[i])); i++; }
        out.push("<table><thead><tr>" + head.map(c => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map(r => "<tr>" + r.map(c => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>");
        continue;
      }
      if(/^\s*[-*+]\s+/.test(l)){
        const items = [];
        while(i < lines.length && /^\s*[-*+]\s+/.test(lines[i])){ items.push(lines[i].replace(/^\s*[-*+]\s+/,"")); i++; }
        out.push("<ul>" + items.map(x => "<li>" + inline(x) + "</li>").join("") + "</ul>");
        continue;
      }
      if(/^\s*\d+[.)]\s+/.test(l)){
        const items = [];
        while(i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])){ items.push(lines[i].replace(/^\s*\d+[.)]\s+/,"")); i++; }
        out.push("<ol>" + items.map(x => "<li>" + inline(x) + "</li>").join("") + "</ol>");
        continue;
      }
      const p = [];
      while(i < lines.length && lines[i].trim() && !fence(lines[i]) &&
        !/^(#{1,6}\s|\s*>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
        !/^(\s*[-*_]){3,}\s*$/.test(lines[i])){
        p.push(lines[i]);
        i++;
      }
      if(p.length) out.push("<p>" + inline(p.join("\n")).replace(/\n/g,"<br>") + "</p>");
      else i++;
    }
    return sanitizeHtml(out.join(""));
  }

  window.sanitizeHtml = sanitizeHtml;
  window.md = md;
})();
