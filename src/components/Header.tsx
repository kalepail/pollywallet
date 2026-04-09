import { Link } from "@tanstack/react-router";
import { Wallet } from "lucide-react";

export default function Header() {
  return (
    <header className="px-6 py-4 flex items-center bg-slate-900 border-b border-slate-800 text-white">
      <Link to="/" className="flex items-center gap-3">
        <Wallet className="w-6 h-6 text-cyan-400" />
        <span className="text-xl font-bold tracking-tight">PollyWallet</span>
      </Link>
      <span className="ml-3 text-xs bg-cyan-500/20 text-cyan-400 px-2 py-0.5 rounded-full font-medium">
        Testnet
      </span>
    </header>
  );
}
