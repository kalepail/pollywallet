import { Code } from "@phosphor-icons/react";
import type { PolicySchema } from "@/lib/policy-schema";
import { schemaToJSON } from "@/lib/policy-schema";

interface SchemaPreviewProps {
  schema: PolicySchema;
}

export default function SchemaPreview({ schema }: SchemaPreviewProps) {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Code size={20} weight="bold" className="text-violet-400" />
        Schema Preview
      </h2>
      <pre className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 overflow-x-auto text-sm text-gray-300 font-mono leading-relaxed max-h-96 overflow-y-auto">
        {schemaToJSON(schema)}
      </pre>
    </div>
  );
}
