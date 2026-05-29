#!/usr/bin/env python3
# gemini_worker.py
# Requisitos: pip install gemini_webapi
#
# Lê o prompt da STDIN, gera resposta via API interna do Gemini (gemini_webapi),
# rotacionando entre os proxies de proxies.txt. Imprime UMA linha JSON na STDOUT:
#   {"ok": true,  "text": "...", "proxy": "..."}
#   {"ok": false, "error": "...", "fatal": true|false}

import sys
import os
import json
import random
import asyncio

from gemini_webapi import GeminiClient

# Model é opcional e o nome do enum varia entre versões -> importa de forma defensiva
try:
    from gemini_webapi.constants import Model
except Exception:
    Model = None

BASE = os.path.dirname(os.path.abspath(__file__))
COOKIES_FILE = os.path.join(BASE, "cookies.json")
PROXIES_FILE = os.path.join(BASE, "proxies.txt")
COOKIE_CACHE = os.path.join(BASE, ".gemini_cookies")

# Persiste o __Secure-1PSIDTS auto-renovado entre execuções (evita re-login frequente)
os.environ.setdefault("GEMINI_COOKIE_PATH", COOKIE_CACHE)


def load_cookies():
    """Aceita {"__Secure-1PSID": "...", "__Secure-1PSIDTS": "..."} OU export
    de extensão (array de objetos {name, value})."""
    with open(COOKIES_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        d = {c.get("name"): c.get("value") for c in data}
    else:
        d = data
    psid = d.get("__Secure-1PSID")
    psidts = d.get("__Secure-1PSIDTS", "") or ""
    if not psid:
        raise RuntimeError("cookies.json sem __Secure-1PSID")
    return psid, psidts


def load_proxies():
    if not os.path.exists(PROXIES_FILE):
        return []
    out = []
    with open(PROXIES_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def resolve_model():
    """Permite escolher o modelo via env GEMINI_MODEL (ex.: G_2_5_FLASH).
    Se não der, deixa o default da lib."""
    name = os.environ.get("GEMINI_MODEL")
    if name and Model is not None and hasattr(Model, name):
        return getattr(Model, name)
    return None


def is_fatal(exc):
    """Erros que NÃO se resolvem trocando de IP -> não adianta rotacionar."""
    return type(exc).__name__ in ("AuthError", "UsageLimitExceeded", "ModelInvalid")


async def try_once(prompt, proxy, psid, psidts):
    # Cada chamada cria um client com um proxy diferente -> rotação de IP real
    client = GeminiClient(psid, psidts, proxy=proxy)
    await client.init(timeout=60, auto_close=False, auto_refresh=True)
    try:
        model = resolve_model()
        if model is not None:
            resp = await client.generate_content(prompt, model=model)
        else:
            resp = await client.generate_content(prompt)
        text = (getattr(resp, "text", "") or "").strip()
        if not text:
            raise RuntimeError("resposta vazia")
        return text
    finally:
        try:
            await client.close()
        except Exception:
            pass


async def main():
    prompt = sys.stdin.read().strip()
    if not prompt and len(sys.argv) > 1:
        prompt = sys.argv[1]
    if not prompt:
        print(json.dumps({"ok": False, "error": "prompt vazio", "fatal": True}))
        return

    try:
        psid, psidts = load_cookies()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"cookies: {e}", "fatal": True}))
        return

    proxies = load_proxies()
    random.shuffle(proxies)
    # Se não houver proxies, tenta direto (None). Útil em máquina local residencial.
    candidates = proxies if proxies else [None]

    last_err = None
    for proxy in candidates:
        try:
            text = await try_once(prompt, proxy, psid, psidts)
            print(json.dumps({"ok": True, "text": text, "proxy": proxy}, ensure_ascii=False))
            return
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if is_fatal(e):
                print(json.dumps({"ok": False, "error": last_err, "fatal": True}, ensure_ascii=False))
                return
            # erro transitório (bloqueio/timeout/api) -> rotaciona pro próximo proxy
            sys.stderr.write(f"[worker] proxy {proxy} falhou: {last_err}\n")
            continue

    print(json.dumps({"ok": False, "error": last_err or "sem proxies disponíveis", "fatal": False}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())