#!/usr/bin/env python3
"""
Caisse Atelier Mercel — serveur autonome (stdlib Python + SQLite).
Aucune dépendance externe. Sert l'API JSON sous /api/* et les fichiers
statiques (static/) pour tout le reste.
"""
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "atelier.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = int(os.environ.get("PORT", "8000"))

ADMIN_CODE_DEFAULT = os.environ.get("ADMIN_CODE_DEFAULT", "")
CAISSE_CODE_DEFAULT = os.environ.get("CAISSE_CODE_DEFAULT", "")

os.makedirs(DATA_DIR, exist_ok=True)

_db_lock = threading.Lock()


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            admin_code TEXT NOT NULL,
            caisse_code TEXT NOT NULL,
            created_iso TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stock_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT NOT NULL,
            categorie TEXT NOT NULL DEFAULT 'Autre',
            unite TEXT NOT NULL DEFAULT 'pièce',
            quantite REAL NOT NULL DEFAULT 0,
            seuil_alerte REAL NOT NULL DEFAULT 2,
            prix_achat REAL NOT NULL DEFAULT 0,
            prix_vente REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ventes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero TEXT NOT NULL,
            date_iso TEXT NOT NULL,
            caissiere_nom TEXT NOT NULL,
            technicien TEXT,
            client_nom TEXT NOT NULL,
            client_tel TEXT,
            type_vehicule TEXT,
            marque TEXT,
            immatriculation TEXT,
            km_actuel TEXT,
            km_prochain TEXT,
            type_travail TEXT,
            montant REAL NOT NULL DEFAULT 0,
            montant_pieces REAL NOT NULL DEFAULT 0,
            montant_main_oeuvre REAL NOT NULL DEFAULT 0,
            visite_numero INTEGER NOT NULL DEFAULT 1,
            annulee INTEGER NOT NULL DEFAULT 0,
            motif_annulation TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS vente_articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vente_id INTEGER NOT NULL REFERENCES ventes(id),
            item_id INTEGER,
            nom TEXT NOT NULL,
            quantite REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_iso TEXT NOT NULL,
            acteur TEXT NOT NULL,
            action TEXT NOT NULL,
            cible TEXT NOT NULL,
            motif TEXT NOT NULL
        );
        """
    )
    conn.commit()
    row = conn.execute("SELECT * FROM config WHERE id = 1").fetchone()
    if row is None and ADMIN_CODE_DEFAULT and CAISSE_CODE_DEFAULT:
        conn.execute(
            "INSERT INTO config (id, admin_code, caisse_code, created_iso) VALUES (1, ?, ?, ?)",
            (ADMIN_CODE_DEFAULT, CAISSE_CODE_DEFAULT, now_iso()),
        )
        conn.commit()
    conn.close()


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


# ---------------- sessions (in-memory; fine for a single small instance) ----------------
SESSIONS = {}  # token -> {role, nom, ts}


def create_session(role, nom):
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = {"role": role, "nom": nom, "ts": time.time()}
    return token


def session_for(token):
    s = SESSIONS.get(token)
    if not s:
        return None
    if time.time() - s["ts"] > 60 * 60 * 24 * 7:  # 7 jours
        SESSIONS.pop(token, None)
        return None
    return s


def normalize_phone_gn(tel):
    d = re.sub(r"[^0-9]", "", tel or "")
    if not d:
        return ""
    if d.startswith("00"):
        d = d[2:]
    if d.startswith("224"):
        return d
    if d.startswith("0"):
        d = d[1:]
    return "224" + d


def row_to_item(r):
    return {
        "id": r["id"], "nom": r["nom"], "categorie": r["categorie"], "unite": r["unite"],
        "quantite": r["quantite"], "seuil_alerte": r["seuil_alerte"],
        "prix_achat": r["prix_achat"], "prix_vente": r["prix_vente"],
    }


def row_to_vente(r, articles):
    return {
        "id": r["id"], "numero": r["numero"], "dateISO": r["date_iso"],
        "caissiere_nom": r["caissiere_nom"], "technicien": r["technicien"],
        "client_nom": r["client_nom"], "client_tel": r["client_tel"],
        "type_vehicule": r["type_vehicule"], "marque": r["marque"],
        "immatriculation": r["immatriculation"], "km_actuel": r["km_actuel"],
        "km_prochain": r["km_prochain"], "type_travail": r["type_travail"],
        "montant": r["montant"], "montant_pieces": r["montant_pieces"],
        "montant_main_oeuvre": r["montant_main_oeuvre"], "visite_numero": r["visite_numero"],
        "annulee": bool(r["annulee"]), "motif_annulation": r["motif_annulation"],
        "articles": articles,
    }


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "AtelierMercel/1.0"

    def log_message(self, fmt, *args):
        pass  # calme le journal par défaut

    # ---------- helpers ----------
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "JSON invalide.")

    def _auth(self):
        token = self.headers.get("X-Auth-Token") or parse_qs(urlparse(self.path).query).get("token", [None])[0]
        s = session_for(token) if token else None
        if not s:
            raise ApiError(401, "Session invalide ou expirée. Reconnecte-toi.")
        return s

    def _require_admin(self):
        s = self._auth()
        if s["role"] != "admin":
            raise ApiError(403, "Réservé à l'administrateur.")
        return s

    # ---------- routing ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            try:
                self._route_get(path)
            except ApiError as e:
                self._send_json(e.status, {"error": e.message})
            except Exception as e:
                self._send_json(500, {"error": "Erreur serveur: " + str(e)})
            return
        self._serve_static(path)

    def do_POST(self):
        self._dispatch_write(urlparse(self.path).path)

    def do_PATCH(self):
        self._dispatch_write(urlparse(self.path).path)

    def do_DELETE(self):
        self._dispatch_write(urlparse(self.path).path)

    def _dispatch_write(self, path):
        if not path.startswith("/api/"):
            self._send_json(404, {"error": "Introuvable."})
            return
        try:
            self._route_write(path)
        except ApiError as e:
            self._send_json(e.status, {"error": e.message})
        except Exception as e:
            self._send_json(500, {"error": "Erreur serveur: " + str(e)})

    # ---------- static files ----------
    def _serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        safe_rel = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(STATIC_DIR, safe_rel)
        if not os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)):
            self.send_response(403)
            self.end_headers()
            return
        if not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        ctype = "text/html; charset=utf-8"
        if full.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif full.endswith(".json"):
            ctype = "application/json; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- GET api ----------
    def _route_get(self, path):
        conn = get_conn()
        try:
            if path == "/api/config/status":
                row = conn.execute("SELECT id FROM config WHERE id = 1").fetchone()
                self._send_json(200, {"configured": row is not None})
                return
            if path == "/api/stock":
                self._auth()
                rows = conn.execute("SELECT * FROM stock_items ORDER BY categorie, nom").fetchall()
                self._send_json(200, {"items": [row_to_item(r) for r in rows]})
                return
            if path == "/api/ventes":
                s = self._auth()
                if s["role"] == "admin":
                    rows = conn.execute("SELECT * FROM ventes ORDER BY date_iso DESC LIMIT 500").fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM ventes WHERE caissiere_nom = ? ORDER BY date_iso DESC LIMIT 500",
                        (s["nom"],),
                    ).fetchall()
                out = []
                for r in rows:
                    arts = conn.execute(
                        "SELECT nom, quantite, item_id FROM vente_articles WHERE vente_id = ?", (r["id"],)
                    ).fetchall()
                    out.append(row_to_vente(r, [dict(a) for a in arts]))
                self._send_json(200, {"ventes": out})
                return
            if path == "/api/bilan":
                self._require_admin()
                self._send_json(200, self._compute_bilan(conn))
                return
            if path == "/api/audit":
                self._require_admin()
                rows = conn.execute("SELECT * FROM audit_log ORDER BY date_iso DESC LIMIT 300").fetchall()
                self._send_json(200, {"audit": [dict(r) for r in rows]})
                return
            if path == "/api/export":
                self._require_admin()
                self._send_export(conn)
                return
            self._send_json(404, {"error": "Route inconnue."})
        finally:
            conn.close()

    def _compute_bilan(self, conn):
        def resume(where_sql, params):
            rows = conn.execute(
                f"SELECT * FROM ventes WHERE annulee = 0 AND {where_sql}", params
            ).fetchall()
            nb = len(rows)
            montant = sum(r["montant"] for r in rows)
            pieces = sum(r["montant_pieces"] for r in rows)
            main_oeuvre = sum(r["montant_main_oeuvre"] for r in rows)
            ids = [r["id"] for r in rows]
            pieces_vendues = 0.0
            litres_huile = 0.0
            if ids:
                qmarks = ",".join("?" * len(ids))
                arts = conn.execute(
                    f"SELECT nom, quantite FROM vente_articles WHERE vente_id IN ({qmarks})", ids
                ).fetchall()
                for a in arts:
                    pieces_vendues += a["quantite"]
                    if "huile moteur" in (a["nom"] or "").lower():
                        litres_huile += a["quantite"]
            return {
                "nb_ventes": nb, "montant_total": montant, "montant_pieces": pieces,
                "montant_main_oeuvre": main_oeuvre, "pieces_vendues": pieces_vendues,
                "litres_huile": litres_huile,
            }

        today = date.today().isoformat()
        month = today[:7]
        jour = resume("substr(date_iso,1,10) = ?", (today,))
        mois = resume("substr(date_iso,1,7) = ?", (month,))
        depuis_debut = resume("1=1", ())
        items = conn.execute("SELECT * FROM stock_items").fetchall()
        valeur_achat = sum(i["quantite"] * i["prix_achat"] for i in items)
        valeur_vente = sum(i["quantite"] * i["prix_vente"] for i in items)
        quantite_totale = sum(i["quantite"] for i in items)
        huile_item = conn.execute(
            "SELECT * FROM stock_items WHERE lower(nom) LIKE '%huile moteur%' LIMIT 1"
        ).fetchone()
        huile_restant = huile_item["quantite"] if huile_item else 0
        return {
            "jour": jour, "mois": mois, "depuis_debut": depuis_debut,
            "stock": {
                "quantite_totale": quantite_totale, "valeur_achat": valeur_achat,
                "valeur_vente": valeur_vente,
            },
            "huile": {
                "nom": huile_item["nom"] if huile_item else None,
                "restant": huile_restant,
            },
        }

    def _send_export(self, conn):
        stock = [dict(r) for r in conn.execute("SELECT * FROM stock_items").fetchall()]
        ventes = [dict(r) for r in conn.execute("SELECT * FROM ventes").fetchall()]
        articles = [dict(r) for r in conn.execute("SELECT * FROM vente_articles").fetchall()]
        audit = [dict(r) for r in conn.execute("SELECT * FROM audit_log").fetchall()]
        payload = {
            "exported_at": now_iso(), "stock_items": stock, "ventes": ventes,
            "vente_articles": articles, "audit_log": audit,
        }
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        fname = "sauvegarde-atelier-mercel-" + date.today().isoformat() + ".json"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # ---------- write api ----------
    def _route_write(self, path):
        method = self.command
        conn = get_conn()
        try:
            if method == "POST" and path == "/api/setup":
                self._api_setup(conn)
                return
            if method == "POST" and path == "/api/login":
                self._api_login(conn)
                return
            if method == "POST" and path == "/api/stock":
                self._api_stock_create(conn)
                return
            m = re.match(r"^/api/stock/(\d+)/achat$", path)
            if method == "POST" and m:
                self._api_stock_achat(conn, int(m.group(1)))
                return
            m = re.match(r"^/api/stock/(\d+)$", path)
            if method == "DELETE" and m:
                self._api_stock_delete(conn, int(m.group(1)))
                return
            if method == "POST" and path == "/api/ventes":
                self._api_vente_create(conn)
                return
            m = re.match(r"^/api/ventes/(\d+)/annuler$", path)
            if method == "POST" and m:
                self._api_vente_annuler(conn, int(m.group(1)))
                return
            if method == "POST" and path == "/api/admin/code":
                self._api_change_code(conn)
                return
            if method == "POST" and path == "/api/import":
                self._api_import(conn)
                return
            self._send_json(404, {"error": "Route inconnue."})
        finally:
            conn.close()

    def _api_setup(self, conn):
        row = conn.execute("SELECT id FROM config WHERE id = 1").fetchone()
        if row is not None:
            raise ApiError(409, "La configuration initiale a déjà été faite.")
        data = self._read_json()
        admin = (data.get("admin") or "").strip()
        caisse = (data.get("caisse") or "").strip()
        if len(admin) < 4 or len(caisse) < 4:
            raise ApiError(400, "Chaque code doit avoir au moins 4 chiffres.")
        if admin == caisse:
            raise ApiError(400, "Les deux codes doivent être différents.")
        with _db_lock:
            conn.execute(
                "INSERT INTO config (id, admin_code, caisse_code, created_iso) VALUES (1, ?, ?, ?)",
                (admin, caisse, now_iso()),
            )
            conn.commit()
        self._send_json(200, {"ok": True})

    def _api_login(self, conn):
        data = self._read_json()
        nom = (data.get("nom") or "").strip()
        code = (data.get("code") or "").strip()
        if not nom:
            raise ApiError(400, "Le nom est requis.")
        cfg = conn.execute("SELECT * FROM config WHERE id = 1").fetchone()
        if cfg is None:
            raise ApiError(409, "Configuration non faite.")
        if code == cfg["admin_code"]:
            role = "admin"
        elif code == cfg["caisse_code"]:
            role = "caissiere"
        else:
            raise ApiError(401, "Code incorrect.")
        token = create_session(role, nom)
        self._send_json(200, {"token": token, "role": role, "nom": nom})

    def _api_stock_create(self, conn):
        self._auth()
        data = self._read_json()
        nom = (data.get("nom") or "").strip()
        if not nom:
            raise ApiError(400, "Le nom est requis.")
        qte = float(data.get("quantite") or 0)
        with _db_lock:
            existing = conn.execute(
                "SELECT * FROM stock_items WHERE lower(trim(nom)) = ?", (nom.lower(),)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE stock_items SET quantite = quantite + ? WHERE id = ?", (qte, existing["id"])
                )
                conn.execute(
                    "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                    (now_iso(), self.headers.get("X-Actor-Name", ""), "achat_stock", existing["nom"],
                     f"+{qte} {existing['unite']} (ajout via formulaire nouvel article)"),
                )
                conn.commit()
                self._send_json(200, {"merged": True, "id": existing["id"]})
                return
            cur = conn.execute(
                "INSERT INTO stock_items (nom, categorie, unite, quantite, seuil_alerte, prix_achat, prix_vente) "
                "VALUES (?,?,?,?,?,?,?)",
                (nom, data.get("categorie") or "Autre", data.get("unite") or "pièce", qte,
                 float(data.get("seuil_alerte") or 2), float(data.get("prix_achat") or 0),
                 float(data.get("prix_vente") or 0)),
            )
            conn.commit()
            self._send_json(200, {"merged": False, "id": cur.lastrowid})

    def _api_stock_achat(self, conn, item_id):
        s = self._auth()
        data = self._read_json()
        qte = float(data.get("quantite") or 0)
        if qte <= 0:
            raise ApiError(400, "Quantité invalide.")
        with _db_lock:
            item = conn.execute("SELECT * FROM stock_items WHERE id = ?", (item_id,)).fetchone()
            if not item:
                raise ApiError(404, "Article introuvable.")
            nouveau_pa = float(data.get("prix_achat", item["prix_achat"]))
            nouveau_pv = float(data.get("prix_vente", item["prix_vente"]))
            changements = []
            if nouveau_pa != item["prix_achat"]:
                changements.append(f"prix d'achat {item['prix_achat']:.0f} → {nouveau_pa:.0f}")
            if nouveau_pv != item["prix_vente"]:
                changements.append(f"prix de vente {item['prix_vente']:.0f} → {nouveau_pv:.0f}")
            conn.execute(
                "UPDATE stock_items SET quantite = quantite + ?, prix_achat = ?, prix_vente = ? WHERE id = ?",
                (qte, nouveau_pa, nouveau_pv, item_id),
            )
            motif = f"+{qte} {item['unite']}" + (" — " + ", ".join(changements) if changements else "")
            conn.execute(
                "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                (now_iso(), s["nom"], "achat_stock", item["nom"], motif),
            )
            conn.commit()
        self._send_json(200, {"ok": True})

    def _api_stock_delete(self, conn, item_id):
        s = self._require_admin()
        data = self._read_json()
        motif = (data.get("motif") or "").strip()
        if not motif:
            raise ApiError(400, "Un motif est obligatoire.")
        with _db_lock:
            item = conn.execute("SELECT * FROM stock_items WHERE id = ?", (item_id,)).fetchone()
            if not item:
                raise ApiError(404, "Article introuvable.")
            conn.execute("DELETE FROM stock_items WHERE id = ?", (item_id,))
            conn.execute(
                "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                (now_iso(), s["nom"], "suppression_stock", item["nom"], motif),
            )
            conn.commit()
        self._send_json(200, {"ok": True})

    def _api_vente_create(self, conn):
        s = self._auth()
        data = self._read_json()
        client_nom = (data.get("client_nom") or "").strip()
        types_travail = data.get("types_travail") or []
        if not client_nom:
            raise ApiError(400, "Le nom du client est requis.")
        if not types_travail:
            raise ApiError(400, "Sélectionne au moins un travail effectué.")
        lignes = [l for l in (data.get("articles") or []) if l.get("item_id") and float(l.get("quantite") or 0) > 0]
        immatriculation = (data.get("immatriculation") or "").strip().upper()

        with _db_lock:
            montant_pieces = 0.0
            article_rows = []
            for l in lignes:
                item = conn.execute("SELECT * FROM stock_items WHERE id = ?", (l["item_id"],)).fetchone()
                if not item:
                    continue
                qte = float(l["quantite"])
                if qte > item["quantite"]:
                    raise ApiError(
                        400,
                        f"Stock insuffisant pour « {item['nom']} » : {item['quantite']} {item['unite']} "
                        f"disponible(s), {qte} demandé(s).",
                    )
                montant_pieces += item["prix_vente"] * qte
                article_rows.append((item["id"], item["nom"], qte))

            main_oeuvre = float(data.get("montant_main_oeuvre") or 0)
            montant = montant_pieces + main_oeuvre
            now = now_iso()
            numero = "ATM-" + now[:10].replace("-", "") + "-" + str(random.randint(1000, 9999))

            if immatriculation:
                visite_numero = conn.execute(
                    "SELECT COUNT(*) c FROM ventes WHERE annulee=0 AND upper(trim(immatriculation))=?",
                    (immatriculation,),
                ).fetchone()["c"] + 1
            else:
                visite_numero = conn.execute(
                    "SELECT COUNT(*) c FROM ventes WHERE annulee=0 AND (immatriculation IS NULL OR trim(immatriculation)='') "
                    "AND lower(trim(client_nom))=?",
                    (client_nom.lower(),),
                ).fetchone()["c"] + 1

            cur = conn.execute(
                "INSERT INTO ventes (numero, date_iso, caissiere_nom, technicien, client_nom, client_tel, "
                "type_vehicule, marque, immatriculation, km_actuel, km_prochain, type_travail, montant, "
                "montant_pieces, montant_main_oeuvre, visite_numero, annulee, motif_annulation) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'')",
                (numero, now, s["nom"], (data.get("technicien") or "").strip(), client_nom,
                 (data.get("client_tel") or "").strip(), data.get("type_vehicule") or "",
                 (data.get("marque") or "").strip(), immatriculation, data.get("km_actuel") or "",
                 data.get("km_prochain") or "", ", ".join(types_travail), montant, montant_pieces,
                 main_oeuvre, visite_numero),
            )
            vente_id = cur.lastrowid
            for item_id, nom, qte in article_rows:
                conn.execute(
                    "INSERT INTO vente_articles (vente_id, item_id, nom, quantite) VALUES (?,?,?,?)",
                    (vente_id, item_id, nom, qte),
                )
                conn.execute("UPDATE stock_items SET quantite = quantite - ? WHERE id = ?", (qte, item_id))
            conn.commit()

            row = conn.execute("SELECT * FROM ventes WHERE id = ?", (vente_id,)).fetchone()
            arts = conn.execute(
                "SELECT nom, quantite, item_id FROM vente_articles WHERE vente_id = ?", (vente_id,)
            ).fetchall()
        self._send_json(200, {"vente": row_to_vente(row, [dict(a) for a in arts])})

    def _api_vente_annuler(self, conn, vente_id):
        s = self._require_admin()
        data = self._read_json()
        motif = (data.get("motif") or "").strip()
        if not motif:
            raise ApiError(400, "Un motif est obligatoire.")
        with _db_lock:
            v = conn.execute("SELECT * FROM ventes WHERE id = ?", (vente_id,)).fetchone()
            if not v:
                raise ApiError(404, "Reçu introuvable.")
            if v["annulee"]:
                raise ApiError(409, "Ce reçu est déjà annulé.")
            arts = conn.execute(
                "SELECT * FROM vente_articles WHERE vente_id = ?", (vente_id,)
            ).fetchall()
            for a in arts:
                if a["item_id"]:
                    conn.execute(
                        "UPDATE stock_items SET quantite = quantite + ? WHERE id = ?",
                        (a["quantite"], a["item_id"]),
                    )
            conn.execute(
                "UPDATE ventes SET annulee = 1, motif_annulation = ? WHERE id = ?", (motif, vente_id)
            )
            conn.execute(
                "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                (now_iso(), s["nom"], "annulation_vente", "reçu " + v["numero"], motif),
            )
            conn.commit()
        self._send_json(200, {"ok": True})

    def _api_import(self, conn):
        """Restaure stock/ventes/articles/journal à partir d'un fichier exporté par
        /api/export. Remplace entièrement les données actuelles (hors codes d'accès)."""
        s = self._require_admin()
        data = self._read_json()
        required = ("stock_items", "ventes", "vente_articles", "audit_log")
        for key in required:
            if key not in data or not isinstance(data[key], list):
                raise ApiError(400, f"Fichier de sauvegarde invalide : « {key} » manquant ou incorrect.")

        with _db_lock:
            conn.execute("DELETE FROM vente_articles")
            conn.execute("DELETE FROM ventes")
            conn.execute("DELETE FROM stock_items")
            conn.execute("DELETE FROM audit_log")

            for it in data["stock_items"]:
                conn.execute(
                    "INSERT INTO stock_items (id, nom, categorie, unite, quantite, seuil_alerte, "
                    "prix_achat, prix_vente) VALUES (?,?,?,?,?,?,?,?)",
                    (it["id"], it["nom"], it.get("categorie") or "Autre", it.get("unite") or "pièce",
                     it.get("quantite") or 0, it.get("seuil_alerte") or 2, it.get("prix_achat") or 0,
                     it.get("prix_vente") or 0),
                )
            for v in data["ventes"]:
                conn.execute(
                    "INSERT INTO ventes (id, numero, date_iso, caissiere_nom, technicien, client_nom, "
                    "client_tel, type_vehicule, marque, immatriculation, km_actuel, km_prochain, "
                    "type_travail, montant, montant_pieces, montant_main_oeuvre, visite_numero, "
                    "annulee, motif_annulation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (v["id"], v["numero"], v["date_iso"], v["caissiere_nom"], v.get("technicien"),
                     v["client_nom"], v.get("client_tel"), v.get("type_vehicule"), v.get("marque"),
                     v.get("immatriculation"), v.get("km_actuel"), v.get("km_prochain"),
                     v.get("type_travail"), v.get("montant") or 0, v.get("montant_pieces") or 0,
                     v.get("montant_main_oeuvre") or 0, v.get("visite_numero") or 1,
                     v.get("annulee") or 0, v.get("motif_annulation") or ""),
                )
            for a in data["vente_articles"]:
                conn.execute(
                    "INSERT INTO vente_articles (id, vente_id, item_id, nom, quantite) VALUES (?,?,?,?,?)",
                    (a["id"], a["vente_id"], a.get("item_id"), a["nom"], a["quantite"]),
                )
            for log in data["audit_log"]:
                conn.execute(
                    "INSERT INTO audit_log (id, date_iso, acteur, action, cible, motif) "
                    "VALUES (?,?,?,?,?,?)",
                    (log["id"], log["date_iso"], log["acteur"], log["action"], log["cible"],
                     log["motif"]),
                )

            # Resynchronise les compteurs auto-incrément pour éviter des collisions d'ID
            # sur les prochains enregistrements créés après la restauration.
            for table in ("stock_items", "ventes", "vente_articles", "audit_log"):
                row = conn.execute(f"SELECT MAX(id) m FROM {table}").fetchone()
                maxid = row["m"] or 0
                conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
                conn.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (table, maxid))

            conn.execute(
                "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                (now_iso(), s["nom"], "restauration_sauvegarde", "toutes les données",
                 "Restauration depuis une sauvegarde exportée le " + str(data.get("exported_at", "date inconnue"))),
            )
            conn.commit()
        self._send_json(200, {
            "ok": True,
            "stock_items": len(data["stock_items"]),
            "ventes": len(data["ventes"]),
        })

    def _api_change_code(self, conn):
        s = self._require_admin()
        data = self._read_json()
        role = data.get("role")
        new_code = (data.get("code") or "").strip()
        if role not in ("admin", "caisse"):
            raise ApiError(400, "Rôle invalide.")
        if len(new_code) < 4:
            raise ApiError(400, "Le code doit avoir au moins 4 chiffres.")
        field = "admin_code" if role == "admin" else "caisse_code"
        with _db_lock:
            conn.execute(f"UPDATE config SET {field} = ? WHERE id = 1", (new_code,))
            conn.execute(
                "INSERT INTO audit_log (date_iso, acteur, action, cible, motif) VALUES (?,?,?,?,?)",
                (now_iso(), s["nom"], "changement_code", role, "Changement demandé par l'administrateur"),
            )
            conn.commit()
        self._send_json(200, {"ok": True})


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Caisse Atelier Mercel — en écoute sur le port {PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
