import { Text } from '@cloudflare/kumo';

interface ErrorAlertProps {
  message: string;
}

export function ErrorAlert({ message }: ErrorAlertProps) {
  return (
    <div className="mx-6 mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
      <Text variant="error">
        <strong>Error:</strong> {message}
      </Text>
    </div>
  );
}
