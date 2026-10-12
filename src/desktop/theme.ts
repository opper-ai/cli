// Platform light theme: platform/lib/styles/globals.css and components/ui/button.tsx.
// Keep the local page self-contained; Inter is served from the packaged font asset.
export const CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url('/inter-latin.woff2') format('woff2')}
:root{
  color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;
  --app-layout:#fafafa;--panel:#ffffff;--panel-accent:#f6f6f6;--panel-row-active:#e6e6ea;
  --panel-border:#d4d4d8;--panel-border-soft:#e4e4e7;--panel-text:#08141f;--panel-text-hover:#1f2d3a;
  --panel-text-2:#4a4a52;--panel-text-3:#6e6e76;--panel-text-4:#a1a1aa;
  --panel-violet:#6d4fb8;--panel-green:#177d38;--panel-red:#c2255c;--brand-navy:#1b2e40;--ring:#bfbfbf;
  color:var(--panel-text);background:var(--app-layout)
}
*{box-sizing:border-box}body{margin:0}main{max-width:1020px;margin:auto;padding:32px 36px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:56px}
.brand{display:inline-flex;color:var(--brand-navy);text-decoration:none}.brand svg{width:108px;height:36px;display:block}
.local{font-size:11.5px;line-height:1.4;color:var(--panel-text-3);border:1px solid var(--panel-border-soft);border-radius:4px;padding:4px 8px;background:var(--panel)}
.eyebrow{font-size:11px;line-height:1.2;font-weight:500;letter-spacing:.12em;color:var(--panel-text-3)}
h1{font-size:38px;font-weight:600;letter-spacing:-.01em;margin:12px 0 10px;line-height:1.1}
.intro>p{color:var(--panel-text-3);font-size:14px;line-height:1.5;margin:0 0 24px}
.active-card{background:var(--panel);border:1px solid var(--panel-border-soft);border-radius:8px;padding:24px}
.section-label{display:flex;align-items:center;gap:8px}.section-label h2{font-size:12.5px;line-height:1.4;color:var(--panel-text-2);margin:0;font-weight:500}
.signal{width:6px;height:6px;border-radius:50%;background:var(--panel-text-4)}.signal.on{background:var(--panel-green);box-shadow:0 0 0 3px #177d3812}
.active-card h3{font-size:22px;line-height:1.3;margin:16px 0 6px;font-weight:600;letter-spacing:-.005em;overflow-wrap:anywhere}
.active-card>p{color:var(--panel-text-3);font-size:13px;line-height:1.55;margin:0;overflow-wrap:anywhere}
.active-bottom{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:24px;border-top:1px solid var(--panel-border-soft);padding-top:14px}
.active-bottom>span{font-size:12.5px;line-height:1.4;color:var(--panel-text-3)}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--panel-border);background:var(--panel);min-height:36px;padding:8px 14px;font-size:13px;line-height:1;font-weight:500;color:var(--panel-text);transition:background .15s,border-color .15s,color .15s}
button:hover{background:var(--panel-accent)}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--ring);outline-offset:2px}button:disabled{cursor:default;opacity:.45}button:disabled:hover{background:var(--panel)}
.quiet{color:var(--panel-text-2);background:transparent;border-color:transparent}.quiet:hover{color:var(--panel-text);background:var(--panel-accent)}
.scope{font-size:12.5px;line-height:1.4;color:var(--panel-text-3);margin:12px 0 24px}
.columns{display:grid;grid-template-columns:1.35fr 1fr;gap:24px}h2{font-size:15px;line-height:1.3;font-weight:600;letter-spacing:-.005em;margin:0}
.section-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.section-top>span{font-size:11.5px;line-height:1.4;color:var(--panel-text-3)}
.session-list{display:flex;flex-direction:column;gap:8px}.session{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px;background:var(--panel);border:1px solid var(--panel-border-soft);border-radius:8px}
.session-views{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--panel-border-soft);border-radius:6px;background:var(--panel-accent);margin-bottom:14px}.session-views button{min-height:30px;padding:6px 10px;border-color:transparent;background:transparent;color:var(--panel-text-3);font-size:12px}.session-views button[aria-pressed="true"]{background:var(--panel);border-color:var(--panel-border-soft);color:var(--panel-text)}.session-views button:hover{color:var(--panel-text)}
.session{flex-wrap:wrap}.session-details{flex:1;min-width:120px}.session-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin-left:auto;max-width:100%}.session-actions button{min-height:32px;padding:7px 10px;font-size:12px}.session-archive{color:var(--panel-text-3)}
.session.selected{border-color:var(--panel-border);background:var(--panel-accent)}.session-details{min-width:0}.session-name{font-size:13px;line-height:1.55;font-weight:500;overflow-wrap:anywhere}.session-project{font-size:11.5px;line-height:1.4;color:var(--panel-text-3);margin-top:4px;overflow-wrap:anywhere}
.selected-label{font-size:11.5px;line-height:1.4;color:var(--panel-green);background:#177d381a;border-radius:4px;padding:4px 8px;white-space:nowrap}
#empty{font-size:13px;line-height:1.55;color:var(--panel-text-3);padding:24px 0}
.create{padding:20px;background:var(--panel);border:1px solid var(--panel-border-soft);border-radius:8px;align-self:start}.create>p{font-size:13px;line-height:1.55;color:var(--panel-text-3);margin:8px 0 24px}
form{display:flex;flex-direction:column}label{font-size:12.5px;line-height:1.4;font-weight:500;color:var(--panel-text-2);margin-bottom:6px}
input{background:var(--panel);color:var(--panel-text);border:1px solid var(--panel-border);border-radius:6px;min-height:36px;padding:8px 12px;font:inherit;font-size:13px;line-height:1.4;margin-bottom:16px;min-width:0}input::placeholder{color:var(--panel-text-4)}
.primary{justify-content:space-between;background:var(--panel-text);color:var(--panel);border-color:var(--panel-text);margin-top:8px}.primary:hover{background:var(--panel-text-hover);border-color:var(--panel-text-hover)}.primary:disabled:hover{background:var(--panel-text)}
#feedback{font-size:12.5px;line-height:1.4;color:var(--panel-green);min-height:18px;margin:24px 0 12px}#feedback.error{color:var(--panel-red)}
footer{border-top:1px solid var(--panel-border-soft);padding-top:16px;font-size:10.5px;line-height:1.5;color:var(--panel-text-3);margin-top:8px}
@media(max-width:680px){main{padding:24px 20px}header{margin-bottom:40px}.columns{grid-template-columns:1fr;gap:24px}.active-card{padding:20px}.scope{margin-bottom:24px}}
`;
