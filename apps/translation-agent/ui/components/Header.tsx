import { LayerCard, Text } from '@cloudflare/kumo';
import { GlobeIcon, ChartBarIcon } from '@phosphor-icons/react';

interface HeaderProps {
  activeTab: 'translate' | 'evaluation';
  onTabChange: (tab: 'translate' | 'evaluation') => void;
}

export function Header({ activeTab, onTabChange }: HeaderProps) {
  return (
    <LayerCard.Secondary className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-800">
      <div className="flex flex-col gap-4">
        <div className="flex justify-start">
          <div className="flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800">
            <button
              onClick={() => onTabChange('translate')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                activeTab === 'translate'
                  ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <GlobeIcon size={16} />
              Translate
            </button>
            <button
              onClick={() => onTabChange('evaluation')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                activeTab === 'evaluation'
                  ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <ChartBarIcon size={16} />
              Evaluation
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <GlobeIcon
            size={28}
            weight="duotone"
            className="text-blue-600 dark:text-blue-400"
          />
          <div>
            <Text variant="heading3">Translation Agent</Text>
            <Text variant="secondary" size="sm">
              Translate text between languages using Cloudflare Workers AI
            </Text>
          </div>
        </div>
      </div>
    </LayerCard.Secondary>
  );
}
