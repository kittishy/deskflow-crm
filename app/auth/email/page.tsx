"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { acceptEmailSession } from "@/app/actions/auth/acceptEmailSession";

export default function EmailReturnPage() {
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const access_token = fragment.get("access_token");
    const refresh_token = fragment.get("refresh_token");
    const type = fragment.get("type");
    // Remove credentials from history before requesting anything.
    window.history.replaceState(null, "", window.location.pathname);
    if (!access_token || !refresh_token) { setFailed(true); return; }
    void acceptEmailSession({ access_token, refresh_token }).then((result) => {
      if (!result.ok) { setFailed(true); return; }
      window.location.replace(type === "invite" || type === "recovery" ? "/login/reset" : "/app");
    }).catch(() => setFailed(true));
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="space-y-4 text-center" role="status">
        <h1 className="text-2xl font-semibold">{failed ? "Link inválido ou expirado" : "Abrindo seu acesso…"}</h1>
        {failed && <Link href="/login" className="underline">Voltar para entrar ou recuperar sua senha</Link>}
      </div>
    </main>
  );
}
