(function(){
  "use strict";
  const TRAVAUX_OPTIONS = ["Vidange d'huile moteur","Vidange de boîte de vitesses","Inspection générale",
    "Graissage / contrôle des niveaux","Gonflage / air comprimé","Réparation courante"];

  let token = localStorage.getItem("atm_token") || null;
  let role = localStorage.getItem("atm_role") || null;
  let actorName = localStorage.getItem("atm_nom") || "";
  let configured = null; // null = unknown yet
  let stockItems = [];
  let ventes = [];
  let audit = [];
  let activeTab = "caisse";
  let draftArticles = [];

  const $root = document.getElementById("root");

  function fmtGNF(n){ n = Math.round(Number(n)||0); return n.toLocaleString("fr-FR") + " GNF"; }
  function fmtDate(iso){
    try { const d = new Date(iso); return d.toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}); }
    catch(e){ return iso; }
  }
  function fmtQty(n){ n = Number(n)||0; return (Math.round(n*100)/100).toString(); }
  function esc(s){ const d=document.createElement("div"); d.textContent = (s==null?"":String(s)); return d.innerHTML; }
  function uid(){ return Math.random().toString(36).slice(2,9); }
  function normalizePhoneGN(tel){
    let d = (tel||"").replace(/[^0-9]/g, "");
    if (!d) return "";
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("224")) return d;
    if (d.startsWith("0")) d = d.slice(1);
    return "224" + d;
  }

  async function api(path, opts){
    opts = opts || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token) headers["X-Auth-Token"] = token;
    if (actorName) headers["X-Actor-Name"] = actorName;
    const res = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch(e){}
    if (!res.ok){
      if (res.status === 401){ doLogout(false); }
      throw new Error(data.error || ("Erreur " + res.status));
    }
    return data;
  }

  function doLogout(reload){
    token = null; role = null; actorName = "";
    localStorage.removeItem("atm_token"); localStorage.removeItem("atm_role"); localStorage.removeItem("atm_nom");
    activeTab = "caisse";
    if (reload !== false) render();
  }

  async function loadAll(){
    const [stockRes, ventesRes] = await Promise.all([api("/stock"), api("/ventes")]);
    stockItems = stockRes.items; ventes = ventesRes.ventes;
    if (role === "admin"){
      const [bilanRes, auditRes] = await Promise.all([api("/bilan"), api("/audit")]);
      window.__bilan = bilanRes;
      audit = auditRes.audit;
    }
  }

  async function render(){
    if (configured === null){
      try {
        const r = await fetch("/api/config/status").then(r=>r.json());
        configured = r.configured;
      } catch(e){ configured = null; }
    }
    if (!configured){
      renderSetup();
      return;
    }
    if (!token || !role){
      renderLogin();
      return;
    }
    try {
      await loadAll();
    } catch(e){
      renderLogin(e.message);
      return;
    }
    renderApp();
  }

  // ---------------- SETUP ----------------
  function renderSetup(){
    $root.innerHTML = `
      <div class="center-screen"><div class="panel">
        <div class="logo-head"><img src="/logo.jpg" alt="Mercel Guinée"><h1>Configuration initiale</h1></div>
        <div class="sub">Personne n'a encore choisi de codes d'accès pour cet atelier. Choisis-les maintenant — tu pourras les changer plus tard depuis l'onglet Administration.</div>
        <div class="field"><label>Code administrateur (toi)</label><input id="su-admin" inputmode="numeric" placeholder="ex. 4 à 6 chiffres"></div>
        <div class="field"><label>Code caisse (à donner à la caissière)</label><input id="su-caisse" inputmode="numeric" placeholder="ex. 4 à 6 chiffres"></div>
        <button class="btn" id="su-btn">Créer les codes</button>
        <div class="errtext" id="su-err"></div>
      </div></div>`;
    document.getElementById("su-btn").onclick = async () => {
      const a = document.getElementById("su-admin").value.trim();
      const c = document.getElementById("su-caisse").value.trim();
      const err = document.getElementById("su-err");
      err.textContent = "";
      try {
        await api("/setup", { method: "POST", body: { admin: a, caisse: c } });
        configured = true;
        render();
      } catch(e){ err.textContent = e.message; }
    };
  }

  // ---------------- LOGIN ----------------
  function renderLogin(errMsg){
    $root.innerHTML = `
      <div class="center-screen"><div class="panel">
        <div class="logo-head"><img src="/logo.jpg" alt="Mercel Guinée"><h1>Caisse Atelier Mercel</h1></div>
        <div class="sub">Atelier de maintenance mécanique — Kankan. Entre ton code d'accès.</div>
        <div class="field"><label>Ton nom (affiché sur les reçus)</label><input id="lg-name" placeholder="Ex. Fatoumata"></div>
        <div class="field"><label>Code d'accès</label><input id="lg-code" type="password" inputmode="numeric" placeholder="••••••"></div>
        <button class="btn" id="lg-btn">Se connecter</button>
        <div class="errtext" id="lg-err">${errMsg ? esc(errMsg) : ""}</div>
      </div></div>`;
    const go = async () => {
      const name = document.getElementById("lg-name").value.trim();
      const code = document.getElementById("lg-code").value.trim();
      const err = document.getElementById("lg-err");
      if (!name){ err.textContent = "Ton nom est requis."; return; }
      try {
        const r = await api("/login", { method: "POST", body: { nom: name, code } });
        token = r.token; role = r.role; actorName = r.nom;
        localStorage.setItem("atm_token", token); localStorage.setItem("atm_role", role); localStorage.setItem("atm_nom", actorName);
        render();
      } catch(e){ err.textContent = e.message; }
    };
    document.getElementById("lg-btn").onclick = go;
    document.getElementById("lg-code").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  }

  // ---------------- APP SHELL ----------------
  function renderApp(){
    const alerts = stockItems.filter(i => i.quantite <= i.seuil_alerte);
    $root.innerHTML = `
      <div class="topbar">
        <div class="brandrow"><img src="/logo.jpg" alt="Mercel Guinée"><div class="brand">MERCEL GUINÉE <small>Atelier — Caisse</small></div></div>
        <div class="who">${esc(actorName)}<br>${role === "admin" ? "Administrateur" : "Caissière"}
          <button class="logout" id="logout-btn">Déconnexion</button>
        </div>
      </div>
      ${alerts.length ? `<div class="alertbar">⚠️ Stock bas : ${alerts.map(a=>esc(a.nom)+" ("+fmtQty(a.quantite)+" "+esc(a.unite)+")").join(", ")}</div>` : ""}
      <div class="tabrail" id="tabrail"></div>
      <div id="tabpane"></div>
    `;
    document.getElementById("logout-btn").onclick = () => doLogout();
    const tabs = [["caisse","Nouveau reçu"],["historique","Historique"],["stock","Stock"]];
    if (role === "admin") tabs.push(["bilan","Bilan"],["admin","Administration"]);
    const rail = document.getElementById("tabrail");
    rail.innerHTML = "";
    tabs.forEach(([key,label]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = activeTab === key ? "active" : "";
      b.onclick = () => { activeTab = key; renderApp(); };
      rail.appendChild(b);
    });
    const pane = document.getElementById("tabpane");
    if (activeTab === "caisse") pane.innerHTML = tplCaisse();
    if (activeTab === "historique") pane.innerHTML = tplHistorique();
    if (activeTab === "stock") pane.innerHTML = tplStock();
    if (activeTab === "bilan") pane.innerHTML = tplBilan();
    if (activeTab === "admin") pane.innerHTML = tplAdmin();
    wireTab();
  }

  // ---------------- CAISSE ----------------
  function tplCaisse(){
    return `
      <div class="card">
        <h2>Nouveau reçu</h2>
        <div class="grid2">
          <div class="field"><label>Nom du client</label><input id="f-client"></div>
          <div class="field"><label>Téléphone du client</label><input id="f-tel" type="tel" placeholder="Ex. 627 80 97 06"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Type de véhicule</label>
            <select id="f-vehicule"><option>Véhicule léger</option><option>Camion</option></select>
          </div>
          <div class="field"><label>Marque du véhicule</label><input id="f-marque" placeholder="Ex. Toyota, MAN, Isuzu"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Immatriculation</label><input id="f-immat" placeholder="Ex. RC 1234 A" style="text-transform:uppercase;"></div>
          <div></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Kilométrage actuel</label><input id="f-km-actuel" type="number" min="0" placeholder="Ex. 85000"></div>
          <div class="field"><label>Prochaine vidange au km</label><input id="f-km-prochain" type="number" min="0" placeholder="Ex. 90000"></div>
        </div>
        <div class="note-inline" style="margin-top:-8px;margin-bottom:10px;">À saisir manuellement selon la qualité de l'huile utilisée — pas de calcul automatique.</div>
        <div class="field"><label>Travaux effectués (plusieurs possibles)</label>
          <div class="chiplist" id="travaux-list">
            ${TRAVAUX_OPTIONS.map(t => `<label class="chip"><input type="checkbox" class="travail-chk" value="${esc(t)}"> ${esc(t)}</label>`).join("")}
          </div>
          <input id="f-travail-autre" placeholder="Autre travail (préciser, optionnel)" style="margin-top:8px;">
        </div>
        <div class="field"><label>Technicien (qui a fait le travail)</label><input id="f-technicien" placeholder="Ex. Ibrahima"></div>
        <div class="field"><label>Pièces / consommables utilisés (optionnel, inclut l'huile moteur)</label>
          <div id="articles-list"></div>
          <button class="btn ghost" id="add-art-btn" type="button" style="width:auto;margin-top:4px;">+ Ajouter une pièce</button>
        </div>
        <div class="field"><label>Total pièces (calculé automatiquement)</label>
          <input id="f-total-pieces" type="text" value="0 GNF" disabled style="font-weight:700;color:var(--navy);">
        </div>
        <div class="field"><label>Main d'œuvre (GNF)</label><input id="f-main-oeuvre" type="number" min="0" placeholder="0"></div>
        <div class="note-inline" style="margin-top:-8px;margin-bottom:10px;">À entendre avec le chef mécanicien — certaines opérations n'ont pas de main d'œuvre facturée.</div>
        <div class="field"><label>Montant total à payer</label>
          <input id="f-montant-total" type="text" value="0 GNF" disabled style="font-weight:700;font-size:1.05rem;color:var(--navy);">
        </div>
        <div class="errtext" id="caisse-err"></div>
        <button class="btn" id="valider-btn">Valider et voir le reçu</button>
      </div>`;
  }
  function renderArticleLines(){
    const wrap = document.getElementById("articles-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    draftArticles.forEach(line => {
      const row = document.createElement("div");
      row.className = "art-line";
      const sel = document.createElement("select");
      sel.appendChild(new Option("— choisir —", ""));
      stockItems.forEach(i => sel.appendChild(new Option(`${i.nom} (stock: ${fmtQty(i.quantite)} ${i.unite})`, i.id)));
      sel.value = line.item_id || "";
      sel.onchange = () => { line.item_id = sel.value; updateTotaux(); };
      const qte = document.createElement("input");
      qte.type = "number"; qte.min = "0"; qte.step = "any"; qte.value = line.quantite;
      qte.oninput = () => { line.quantite = qte.value; updateTotaux(); };
      const del = document.createElement("button");
      del.className = "btn danger"; del.style.width = "auto"; del.style.padding = "8px 10px";
      del.textContent = "✕";
      del.onclick = () => { draftArticles = draftArticles.filter(l => l !== line); renderArticleLines(); updateTotaux(); };
      row.appendChild(sel); row.appendChild(qte); row.appendChild(del);
      wrap.appendChild(row);
    });
  }
  function calcTotalPieces(){
    return draftArticles.reduce((sum, l) => {
      const item = stockItems.find(i => String(i.id) === String(l.item_id));
      return sum + (item && l.item_id ? Number(item.prix_vente) * Number(l.quantite || 0) : 0);
    }, 0);
  }
  function updateTotaux(){
    const totalPieces = document.getElementById("f-total-pieces");
    const totalGlobal = document.getElementById("f-montant-total");
    if (!totalPieces || !totalGlobal) return;
    const pieces = calcTotalPieces();
    const mainOeuvre = Number(document.getElementById("f-main-oeuvre").value || 0);
    totalPieces.value = fmtGNF(pieces);
    totalGlobal.value = fmtGNF(pieces + mainOeuvre);
  }

  async function validerVente(){
    const err = document.getElementById("caisse-err");
    err.textContent = "";
    const types_travail = Array.from(document.querySelectorAll(".travail-chk:checked")).map(c => c.value);
    const travail_autre = document.getElementById("f-travail-autre").value.trim();
    if (travail_autre) types_travail.push(travail_autre);
    const lignes = draftArticles.filter(l => l.item_id && Number(l.quantite) > 0)
      .map(l => ({ item_id: Number(l.item_id), quantite: Number(l.quantite) }));
    const payload = {
      client_nom: document.getElementById("f-client").value.trim(),
      client_tel: document.getElementById("f-tel").value.trim(),
      type_vehicule: document.getElementById("f-vehicule").value,
      marque: document.getElementById("f-marque").value.trim(),
      immatriculation: document.getElementById("f-immat").value.trim(),
      km_actuel: document.getElementById("f-km-actuel").value || "",
      km_prochain: document.getElementById("f-km-prochain").value || "",
      types_travail,
      technicien: document.getElementById("f-technicien").value.trim(),
      montant_main_oeuvre: Number(document.getElementById("f-main-oeuvre").value || 0),
      articles: lignes,
    };
    const btn = document.getElementById("valider-btn");
    btn.disabled = true;
    try {
      const r = await api("/ventes", { method: "POST", body: payload });
      draftArticles = [];
      await loadAll();
      openReceipt(r.vente);
      renderApp();
    } catch(e){
      err.textContent = e.message;
    } finally { btn.disabled = false; }
  }

  // ---------------- RECEIPT ----------------
  function openReceipt(v){
    const back = document.createElement("div");
    back.className = "receipt-backdrop";
    const lignes = (v.articles||[]).map(a => `<tr><td>${esc(a.nom)}</td><td style="text-align:center;">${fmtQty(a.quantite)}</td></tr>`).join("");
    back.innerHTML = `<div class="receipt" id="receipt-print-area">
      <div class="rhead">
        <img src="/logo.jpg" alt="Mercel Guinée">
        <div class="rhead-text">
          <div class="rtag">REÇU DE PAIEMENT</div>
          <div class="rname">MERCEL GUINÉE — Atelier mécanique</div>
          <div class="rsub">RCCM : GN.TCC.2026.A.10881 — NIF : 442571576<br>Tél / WhatsApp : +224 627 80 97 06</div>
        </div>
      </div>
      <div style="font-size:.8rem;color:#555;margin-bottom:10px;">
        Reçu N° <b>${esc(v.numero)}</b> — ${fmtDate(v.dateISO)}<br>
        Caissière : <b>${esc(v.caissiere_nom)}</b>${v.technicien ? ` — Technicien : <b>${esc(v.technicien)}</b>` : ""}${v.annulee ? ' — <span class="cancelled">ANNULÉ</span>' : ""}
      </div>
      <div class="rstats">
        ${v.km_prochain ? `
        <div class="rstat gold">
          <div class="rlabel">Prochaine vidange au km</div>
          <div class="rvalue">${Number(v.km_prochain).toLocaleString("fr-FR")}</div>
          ${v.km_actuel ? `<div class="rsubtext">actuel : ${Number(v.km_actuel).toLocaleString("fr-FR")} km</div>` : ""}
        </div>` : ""}
        <div class="rstat navy">
          <div class="rlabel">${(v.visite_numero||1) >= 10 ? "🎉 Client fidèle" : "Visite n°"}</div>
          <div class="rvalue">${v.visite_numero||1}${(v.visite_numero||1) === 1 ? "ʳᵉ" : "ᵉ"}</div>
          <div class="rsubtext">${(v.visite_numero||1) === 1 ? "Première visite" : "visite à l'atelier"}</div>
        </div>
      </div>
      <table style="width:100%;margin-bottom:10px;">
        <tr><th style="width:40%;">Client</th><td>${esc(v.client_nom)}</td></tr>
        <tr><th>Téléphone</th><td>${v.client_tel ? esc(v.client_tel) : "—"}</td></tr>
        <tr><th>Véhicule</th><td>${esc(v.type_vehicule)}${v.marque ? " — " + esc(v.marque) : ""}</td></tr>
        <tr><th>Immatriculation</th><td>${v.immatriculation ? esc(v.immatriculation) : "—"}</td></tr>
        <tr><th>Travail</th><td>${esc(v.type_travail)}</td></tr>
      </table>
      ${lignes ? `<table style="width:100%;"><tr><th>Pièce</th><th>Qté</th></tr>${lignes}</table>` : ""}
      <table style="width:100%;margin-top:10px;">
        <tr><th style="width:60%;">Total pièces</th><td style="text-align:right;">${fmtGNF(v.montant_pieces||0)}</td></tr>
        <tr><th>Main d'œuvre</th><td style="text-align:right;">${fmtGNF(v.montant_main_oeuvre||0)}</td></tr>
      </table>
      <div class="rtotal">Montant payé : ${fmtGNF(v.montant)}</div>
      <div class="rfoot">Merci de votre confiance — MERCEL GUINÉE, Kankan</div>
      <div class="btn-row" style="margin-top:16px;">
        <button class="btn secondary" id="rc-copy">Copier le texte</button>
        <button class="btn" id="rc-whatsapp" style="background:#25D366;">Envoyer par WhatsApp</button>
      </div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn secondary" id="rc-print">Imprimer</button>
        <button class="btn secondary" id="rc-close">Fermer</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    document.getElementById("rc-close").onclick = () => back.remove();
    document.getElementById("rc-print").onclick = () => window.print();
    const receiptText = () => `MERCEL GUINÉE — Atelier mécanique\nReçu N° ${v.numero} — ${fmtDate(v.dateISO)}\nCaissière: ${v.caissiere_nom}${v.technicien ? "\nTechnicien: " + v.technicien : ""}\nClient: ${v.client_nom}\nTéléphone: ${v.client_tel||"—"}\nVéhicule: ${v.type_vehicule}${v.marque?" — "+v.marque:""}\nImmatriculation: ${v.immatriculation||"—"}\nTravail: ${v.type_travail}\nVisite n°: ${v.visite_numero||1}\n` +
        (v.articles||[]).map(a=>`Pièce: ${a.nom} x${a.quantite}`).join("\n") + `\nTotal pièces: ${fmtGNF(v.montant_pieces||0)}` +
        `\nMain d'œuvre: ${fmtGNF(v.montant_main_oeuvre||0)}\nMontant payé: ${fmtGNF(v.montant)}` +
        (v.km_prochain ? `\nKilométrage actuel: ${v.km_actuel||"—"}\nProchaine vidange au km: ${v.km_prochain}` : "") +
        `\nMerci de votre confiance — MERCEL GUINÉE, Kankan`;
    document.getElementById("rc-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(receiptText()); document.getElementById("rc-copy").textContent = "Copié !"; }
      catch(e){ /* ignore */ }
    };
    document.getElementById("rc-whatsapp").onclick = () => {
      const digits = normalizePhoneGN(v.client_tel);
      const url = "https://wa.me/" + (digits || "") + "?text=" + encodeURIComponent(receiptText());
      window.open(url, "_blank");
    };
  }

  // ---------------- HISTORIQUE ----------------
  function tplHistorique(){
    if (!ventes.length) return `<div class="card"><h2>Historique</h2><div class="empty">Aucun reçu pour l'instant.</div></div>`;
    const rows = ventes.map(v => `
      <tr>
        <td class="num">${esc(v.numero)}</td>
        <td>${fmtDate(v.dateISO)}</td>
        <td>${esc(v.caissiere_nom)}</td>
        <td>${v.technicien ? esc(v.technicien) : "—"}</td>
        <td>${esc(v.client_nom)}</td>
        <td>${esc(v.type_vehicule||"")}${v.marque?" — "+esc(v.marque):""}${v.immatriculation?`<br><span class="num" style="color:var(--ink-dim);font-size:.78rem;">${esc(v.immatriculation)}</span>`:""}</td>
        <td>${v.km_prochain ? esc(v.km_prochain) + " km" : "—"}</td>
        <td class="num">${fmtGNF(v.montant)}${v.annulee ? ' <span class="pill low">ANNULÉ</span>' : ""}</td>
        <td>
          <button class="btn ghost" style="width:auto;padding:6px 10px;" data-voir="${v.id}">Voir</button>
          ${role === "admin" && !v.annulee ? `<button class="btn danger" style="width:auto;padding:6px 10px;margin-left:5px;" data-annuler="${v.id}">Annuler</button>` : ""}
        </td>
      </tr>`).join("");
    return `<div class="card"><h2>Historique des reçus</h2><div class="tablewrap"><table>
      <tr><th>N°</th><th>Date</th><th>Caissière</th><th>Technicien</th><th>Client</th><th>Véhicule</th><th>Proch. vidange</th><th>Montant</th><th></th></tr>
      ${rows}</table></div></div>`;
  }

  function askConfirmDanger(title, message, confirmLabel, onConfirm){
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal-box">
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="errtext" id="confirm-err"></div>
      <div class="btn-row">
        <button class="btn secondary" id="confirm-cancel">Annuler</button>
        <button class="btn danger" id="confirm-ok">${esc(confirmLabel)}</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    document.getElementById("confirm-cancel").onclick = () => back.remove();
    document.getElementById("confirm-ok").onclick = async () => {
      try {
        await onConfirm();
        back.remove();
      } catch(e){ document.getElementById("confirm-err").textContent = e.message; }
    };
  }

  function askMotif(title, onConfirm){
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal-box">
      <h3>${esc(title)}</h3>
      <div class="field"><label>Motif (obligatoire)</label><input id="motif-input" placeholder="Ex. erreur de saisie"></div>
      <div class="errtext" id="motif-err"></div>
      <div class="btn-row">
        <button class="btn secondary" id="motif-cancel">Annuler</button>
        <button class="btn danger" id="motif-ok">Confirmer</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    document.getElementById("motif-cancel").onclick = () => back.remove();
    document.getElementById("motif-ok").onclick = async () => {
      const val = document.getElementById("motif-input").value.trim();
      if (!val){ document.getElementById("motif-err").textContent = "Un motif est obligatoire."; return; }
      try {
        await onConfirm(val);
        back.remove();
      } catch(e){ document.getElementById("motif-err").textContent = e.message; }
    };
  }

  // ---------------- STOCK ----------------
  function tplStock(){
    const sorted = [...stockItems].sort((a,b) => (a.categorie||"").localeCompare(b.categorie||"") || a.nom.localeCompare(b.nom));
    const rows = sorted.map(i => {
      const low = i.quantite <= i.seuil_alerte;
      return `<tr>
        <td>${esc(i.nom)}</td><td>${esc(i.categorie)}</td>
        <td class="num">${fmtQty(i.quantite)} ${esc(i.unite)} <span class="pill ${low?'low':'ok'}">${low?'BAS':'OK'}</span></td>
        ${role === "admin" ? `<td class="num">${fmtGNF(i.prix_achat)}</td><td class="num">${fmtGNF(i.prix_vente)}</td>
          <td style="white-space:nowrap;">
            <button class="btn ghost" style="width:auto;padding:6px 10px;" data-achat="${i.id}">+ Achat</button>
            <button class="btn danger" style="width:auto;padding:6px 10px;margin-left:5px;" data-suppr="${i.id}" title="Supprimer cet article du stock">🗑</button>
          </td>` : ""}
      </tr>`;
    }).join("");
    const head = role === "admin"
      ? `<tr><th>Article</th><th>Catégorie</th><th>Quantité</th><th>Prix achat</th><th>Prix vente</th><th></th></tr>`
      : `<tr><th>Article</th><th>Catégorie</th><th>Quantité</th></tr>`;
    const empty = !sorted.length ? `<div class="empty">Aucun article de stock encore. ${role==="admin"?"Ajoute le premier ci-dessous.":"Demande à l'administrateur d'en ajouter."}</div>` : "";
    return `<div class="card"><h2>État du stock</h2>
      ${empty}
      ${sorted.length ? `<div class="tablewrap"><table>${head}${rows}</table></div>` : ""}
      </div>
      ${role === "admin" ? `
      <div class="card">
        <h2>Ajouter un article de stock</h2>
        <div class="note-inline" style="margin-top:0;margin-bottom:10px;">Si le nom correspond déjà à un article existant, la quantité sera ajoutée à cet article au lieu de créer une nouvelle ligne.</div>
        <div class="grid2">
          <div class="field"><label>Nom</label><input id="ns-nom"></div>
          <div class="field"><label>Catégorie</label><input id="ns-cat" placeholder="Huile, Filtre, Freinage..."></div>
          <div class="field"><label>Unité</label><input id="ns-unite" value="pièce"></div>
          <div class="field"><label>Quantité achetée</label><input id="ns-qte" type="number" min="0" step="any" value="0"></div>
          <div class="field"><label>Seuil d'alerte</label><input id="ns-seuil" type="number" value="2"></div>
          <div class="field"><label>Prix d'achat (GNF)</label><input id="ns-pa" type="number" value="0"></div>
          <div class="field"><label>Prix de vente (GNF)</label><input id="ns-pv" type="number" value="0"></div>
        </div>
        <button class="btn" id="ns-btn">Ajouter l'article</button>
        <div class="errtext" id="ns-err"></div>
        <div class="msgtext" id="ns-msg"></div>
      </div>` : ""}`;
  }

  function askAchat(item){
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal-box">
      <h3>Enregistrer un achat — ${esc(item.nom)}</h3>
      <div class="field"><label>Quantité achetée</label><input id="achat-qte" type="number" min="0" step="any"></div>
      <div class="field"><label>Nouveau prix d'achat (GNF)</label><input id="achat-pa" type="number" min="0" value="${item.prix_achat}"></div>
      <div class="field"><label>Nouveau prix de vente (GNF)</label><input id="achat-pv" type="number" min="0" value="${item.prix_vente}"></div>
      <div class="note-inline" style="margin-bottom:8px;">Si le prix a changé, le nouveau prix s'appliquera à tout le stock de cet article, pas seulement à cet achat.</div>
      <div class="errtext" id="achat-err"></div>
      <div class="btn-row">
        <button class="btn secondary" id="achat-cancel">Annuler</button>
        <button class="btn" id="achat-ok">Enregistrer</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    document.getElementById("achat-cancel").onclick = () => back.remove();
    document.getElementById("achat-ok").onclick = async () => {
      const qte = Number(document.getElementById("achat-qte").value || 0);
      if (qte <= 0){ document.getElementById("achat-err").textContent = "Quantité invalide."; return; }
      try {
        await api(`/stock/${item.id}/achat`, { method: "POST", body: {
          quantite: qte,
          prix_achat: Number(document.getElementById("achat-pa").value || 0),
          prix_vente: Number(document.getElementById("achat-pv").value || 0),
        }});
        back.remove();
        await loadAll(); renderApp();
      } catch(e){ document.getElementById("achat-err").textContent = e.message; }
    };
  }

  function askSupprimerArticle(item){
    const dejaVendu = ventes.some(v => (v.articles||[]).some(a => String(a.item_id) === String(item.id)));
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal-box">
      <h3>Supprimer « ${esc(item.nom)} »</h3>
      <div class="note-inline" style="margin-bottom:10px;">
        Cet article sera retiré de l'état du stock et de la liste des pièces proposées pour un nouveau reçu.
        ${dejaVendu ? `<br><b>Attention :</b> cet article apparaît déjà sur un ou plusieurs reçus passés — ces reçus garderont leur historique.` : ""}
        ${Number(item.quantite) > 0 ? `<br>Il reste actuellement <b>${fmtQty(item.quantite)} ${esc(item.unite)}</b> en stock pour cet article.` : ""}
      </div>
      <div class="field"><label>Motif (obligatoire)</label><input id="suppr-motif" placeholder="Ex. doublon, article retiré du catalogue"></div>
      <div class="errtext" id="suppr-err"></div>
      <div class="btn-row">
        <button class="btn secondary" id="suppr-cancel">Annuler</button>
        <button class="btn danger" id="suppr-ok">Supprimer</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    document.getElementById("suppr-cancel").onclick = () => back.remove();
    document.getElementById("suppr-ok").onclick = async () => {
      const motif = document.getElementById("suppr-motif").value.trim();
      if (!motif){ document.getElementById("suppr-err").textContent = "Un motif est obligatoire."; return; }
      try {
        await api(`/stock/${item.id}`, { method: "DELETE", body: { motif } });
        back.remove();
        await loadAll(); renderApp();
      } catch(e){ document.getElementById("suppr-err").textContent = e.message; }
    };
  }

  // ---------------- BILAN ----------------
  function tplBilan(){
    const b = window.__bilan;
    if (!b) return `<div class="card"><div class="empty">Chargement…</div></div>`;
    const todayLabel = new Date().toLocaleDateString("fr-FR", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
    const monthLabel = new Date().toLocaleDateString("fr-FR", { month:"long", year:"numeric" });
    const statCard = (label, value, sub, gold) =>
      `<div class="statcard${gold?" gold":""}"><div class="slabel">${label}</div><div class="svalue">${value}</div>${sub?`<div class="ssub">${sub}</div>`:""}</div>`;
    return `
      <div class="card">
        <h2>Bilan d'aujourd'hui</h2>
        <div class="note-inline" style="margin-top:-8px;margin-bottom:10px;text-transform:capitalize;">${todayLabel}</div>
        <div class="statgrid">
          ${statCard("Nombre de ventes", b.jour.nb_ventes)}
          ${statCard("Montant total", fmtGNF(b.jour.montant_total), null, true)}
          ${statCard("Dont pièces", fmtGNF(b.jour.montant_pieces))}
          ${statCard("Dont main d'œuvre", fmtGNF(b.jour.montant_main_oeuvre))}
          ${statCard("Pièces vendues", fmtQty(b.jour.pieces_vendues))}
        </div>
      </div>
      <div class="card">
        <h2>Bilan du mois</h2>
        <div class="note-inline" style="margin-top:-8px;margin-bottom:10px;text-transform:capitalize;">${monthLabel}</div>
        <div class="statgrid">
          ${statCard("Nombre de ventes", b.mois.nb_ventes)}
          ${statCard("Montant total", fmtGNF(b.mois.montant_total), null, true)}
          ${statCard("Dont pièces", fmtGNF(b.mois.montant_pieces))}
          ${statCard("Dont main d'œuvre", fmtGNF(b.mois.montant_main_oeuvre))}
          ${statCard("Pièces vendues", fmtQty(b.mois.pieces_vendues))}
        </div>
      </div>
      <div class="card">
        <h2>Huile moteur</h2>
        <div class="note-inline" style="margin-top:-8px;margin-bottom:10px;">Litres vendus et litres restants dans le stock « ${b.huile.nom ? esc(b.huile.nom) : "Huile moteur"} ».</div>
        <div class="statgrid">
          ${statCard("Vendue aujourd'hui", fmtQty(b.jour.litres_huile)+" L")}
          ${statCard("Vendue ce mois", fmtQty(b.mois.litres_huile)+" L")}
          ${statCard("Vendue depuis le début", fmtQty(b.depuis_debut.litres_huile)+" L")}
          ${statCard("Restant en stock", fmtQty(b.huile.restant)+" L", null, true)}
        </div>
      </div>
      <div class="card">
        <h2>Valeur du stock actuel</h2>
        <div class="statgrid">
          ${statCard("Quantité totale en stock", fmtQty(b.stock.quantite_totale))}
          ${statCard("Valeur au prix d'achat", fmtGNF(b.stock.valeur_achat), "ce que ça a coûté")}
          ${statCard("Valeur au prix de vente", fmtGNF(b.stock.valeur_vente), "ce que ça peut rapporter", true)}
        </div>
      </div>
      <div class="card">
        <h2>Depuis le début</h2>
        <div class="statgrid">
          ${statCard("Nombre de ventes", b.depuis_debut.nb_ventes)}
          ${statCard("Montant total encaissé", fmtGNF(b.depuis_debut.montant_total), null, true)}
          ${statCard("Total pièces vendues", fmtQty(b.depuis_debut.pieces_vendues))}
        </div>
      </div>`;
  }

  // ---------------- ADMIN ----------------
  function tplAdmin(){
    const rows = audit.slice(0,100).map(a => `<tr><td>${fmtDate(a.date_iso)}</td><td>${esc(a.acteur)}</td><td>${esc(a.action)}</td><td>${esc(a.cible)}</td><td>${esc(a.motif)}</td></tr>`).join("");
    return `
      <div class="card">
        <h2>Changer un code d'accès</h2>
        <div class="grid2">
          <div class="field"><label>Rôle</label>
            <select id="ac-role"><option value="caisse">Code Caisse</option><option value="admin">Code Administrateur</option></select>
          </div>
          <div class="field"><label>Nouveau code (4 chiffres min.)</label><input id="ac-code" inputmode="numeric"></div>
        </div>
        <button class="btn" id="ac-btn">Changer le code</button>
        <div class="msgtext" id="ac-msg"></div>
      </div>
      <div class="card">
        <h2>Sauvegarde des données</h2>
        <div class="note-inline" style="margin-top:0;margin-bottom:10px;">Tant que l'hébergement reste sur le plan gratuit, les données peuvent être effacées lors d'un redémarrage du service. Télécharge régulièrement une sauvegarde (surtout avant toute période d'inactivité) pour ne rien perdre.</div>
        <button class="btn secondary" id="export-btn">⬇ Exporter les données (.json)</button>
        <div class="note-inline" style="margin-bottom:10px;">Si les données ont été effacées (redémarrage sur le plan gratuit), tu peux les remettre en place à partir d'un fichier exporté précédemment. <strong>Attention : ceci remplace entièrement les données actuelles</strong> — à utiliser seulement pour restaurer après une perte, pas pour fusionner deux sauvegardes.</div>
        <input type="file" id="import-file" accept="application/json" style="display:none;">
        <button class="btn secondary" id="import-btn">⬆ Importer une sauvegarde (.json)</button>
        <div class="msgtext" id="import-msg"></div>
      </div>
      <div class="card">
        <h2>Journal des modifications</h2>
        ${audit.length ? `<div class="tablewrap"><table><tr><th>Date</th><th>Par</th><th>Action</th><th>Cible</th><th>Motif</th></tr>${rows}</table></div>` : `<div class="empty">Aucune modification enregistrée.</div>`}
      </div>`;
  }

  // ---------------- WIRE TAB EVENTS ----------------
  function wireTab(){
    if (activeTab === "caisse"){
      renderArticleLines();
      document.getElementById("add-art-btn").onclick = () => { draftArticles.push({ _k: uid(), item_id: "", quantite: 1 }); renderArticleLines(); updateTotaux(); };
      document.getElementById("valider-btn").onclick = validerVente;
      document.getElementById("f-main-oeuvre").oninput = updateTotaux;
      updateTotaux();
    }
    if (activeTab === "historique"){
      document.querySelectorAll("[data-voir]").forEach(b => b.onclick = () => {
        const v = ventes.find(x => String(x.id) === b.dataset.voir);
        if (v) openReceipt(v);
      });
      document.querySelectorAll("[data-annuler]").forEach(b => b.onclick = () => {
        const v = ventes.find(x => String(x.id) === b.dataset.annuler);
        if (!v) return;
        askMotif("Annuler le reçu " + v.numero, async (motif) => {
          await api(`/ventes/${v.id}/annuler`, { method: "POST", body: { motif } });
          await loadAll(); renderApp();
        });
      });
    }
    if (activeTab === "stock" && role === "admin"){
      document.querySelectorAll("[data-achat]").forEach(b => b.onclick = () => {
        const item = stockItems.find(i => String(i.id) === b.dataset.achat);
        if (item) askAchat(item);
      });
      document.querySelectorAll("[data-suppr]").forEach(b => b.onclick = () => {
        const item = stockItems.find(i => String(i.id) === b.dataset.suppr);
        if (item) askSupprimerArticle(item);
      });
      document.getElementById("ns-btn").onclick = async () => {
        const nom = document.getElementById("ns-nom").value.trim();
        const err = document.getElementById("ns-err");
        const msg = document.getElementById("ns-msg");
        err.textContent = ""; msg.textContent = "";
        if (!nom){ err.textContent = "Le nom est requis."; return; }
        try {
          const r = await api("/stock", { method: "POST", body: {
            nom, categorie: document.getElementById("ns-cat").value || "Autre",
            unite: document.getElementById("ns-unite").value || "pièce",
            seuil_alerte: Number(document.getElementById("ns-seuil").value || 2),
            prix_achat: Number(document.getElementById("ns-pa").value || 0),
            prix_vente: Number(document.getElementById("ns-pv").value || 0),
            quantite: Number(document.getElementById("ns-qte").value || 0),
          }});
          msg.textContent = r.merged ? `L'article existait déjà — la quantité a été ajoutée, pas de nouvelle ligne créée.` : `Article « ${nom} » ajouté.`;
          ["ns-nom","ns-cat","ns-unite","ns-qte","ns-seuil","ns-pa","ns-pv"].forEach(id => {
            const el = document.getElementById(id);
            if (el && id !== "ns-unite") el.value = (id === "ns-seuil") ? "2" : "0";
            if (id === "ns-nom" || id === "ns-cat") el.value = "";
          });
          await loadAll(); renderApp();
          document.getElementById("ns-msg").textContent = msg.textContent;
        } catch(e){ err.textContent = e.message; }
      };
    }
    if (activeTab === "admin"){
      document.getElementById("ac-btn").onclick = async () => {
        const roleSel = document.getElementById("ac-role").value;
        const newCode = document.getElementById("ac-code").value.trim();
        const msg = document.getElementById("ac-msg");
        if (newCode.length < 4){ msg.style.color = "var(--red)"; msg.textContent = "Le code doit avoir au moins 4 chiffres."; return; }
        try {
          await api("/admin/code", { method: "POST", body: { role: roleSel, code: newCode } });
          msg.style.color = "var(--green)"; msg.textContent = "Code mis à jour.";
          document.getElementById("ac-code").value = "";
        } catch(e){ msg.style.color = "var(--red)"; msg.textContent = e.message; }
      };
      document.getElementById("export-btn").onclick = () => {
        window.open("/api/export?token=" + encodeURIComponent(token), "_blank");
      };
      document.getElementById("import-btn").onclick = () => {
        document.getElementById("import-file").click();
      };
      document.getElementById("import-file").onchange = (ev) => {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = ""; // permet de réimporter le même fichier plus tard si besoin
        if (!file) return;
        const importMsg = document.getElementById("import-msg");
        importMsg.style.color = ""; importMsg.textContent = "";
        const reader = new FileReader();
        reader.onload = () => {
          let parsed;
          try { parsed = JSON.parse(reader.result); }
          catch(e){ importMsg.style.color = "var(--red)"; importMsg.textContent = "Ce fichier n'est pas une sauvegarde valide (JSON illisible)."; return; }
          if (!Array.isArray(parsed.stock_items) || !Array.isArray(parsed.ventes)){
            importMsg.style.color = "var(--red)"; importMsg.textContent = "Ce fichier ne ressemble pas à une sauvegarde de cette application.";
            return;
          }
          const dateTxt = parsed.exported_at ? fmtDate(parsed.exported_at) : "date inconnue";
          askConfirmDanger(
            "Restaurer cette sauvegarde ?",
            `Cette sauvegarde a été exportée le ${dateTxt}. Toutes les données actuelles (ventes, stock, journal) seront remplacées par celles de ce fichier. Cette action ne peut pas être annulée.`,
            "Oui, restaurer",
            async () => {
              await api("/import", { method: "POST", body: parsed });
              await loadAll(); renderApp();
              importMsg.style.color = "var(--green)";
              importMsg.textContent = "Sauvegarde restaurée avec succès.";
            }
          );
        };
        reader.readAsText(file);
      };
    }
  }

  render();
})();
