import { Link } from "@tanstack/react-router";
import { Wallet, ShieldCheck } from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";

export default function Header() {
  return (
    <header className="px-6 py-4 flex items-center bg-slate-900 border-b border-slate-800 text-white">
      <Link to="/" className="flex items-center gap-3">
        <Wallet size={24} weight="bold" className="text-cyan-400" />
        <span className="text-xl font-bold tracking-tight">PollyWallet</span>
      </Link>
      <span className="ml-3">
        <Badge variant="teal">Testnet</Badge>
      </span>
      <nav className="ml-auto flex items-center gap-4">
        <Link
          to="/policies"
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-violet-400 transition-colors"
        >
          <ShieldCheck size={16} weight="bold" />
          Policies
        </Link>
      </nav>
    </header>
  );
}
