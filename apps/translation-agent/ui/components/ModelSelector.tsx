import { Label } from '@cloudflare/kumo';
import { MODELS } from '../constants';

interface ModelSelectorProps {
  selectedModel: string;
  onChange: (model: string) => void;
  disabled: boolean;
}

export function ModelSelector({
  selectedModel,
  onChange,
  disabled
}: ModelSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Model</Label>
      <select
        value={selectedModel}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {MODELS.map((model) => (
          <option key={model.value} value={model.value}>
            {model.label}
          </option>
        ))}
      </select>
    </div>
  );
}
