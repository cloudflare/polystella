import { InputArea, Label, Text } from '@cloudflare/kumo';
import { TOKEN_LIMIT, LOCALES_MAP } from '../constants';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  tokenCount: number;
  disabled: boolean;
  /**
   * Currently selected source locale (BCP-47). Drives the label and
   * placeholder so the UI tells users what language they should be
   * typing in. Defaults to "en-US" via App-level state.
   */
  sourceLocale: string;
}

/**
 * Resolves a human-readable language name from a BCP-47 code by
 * looking up `LOCALES_MAP`. Falls back to the code itself for any
 * locale not in the UI's known list (defensive — the source picker
 * only exposes codes from `LOCALES`/`ADDITIONAL_LOCALES`, both of
 * which are in `LOCALES_MAP`).
 */
function getSourceLanguageName(code: string): string {
  return LOCALES_MAP.get(code)?.name ?? code;
}

export function TextInput({
  value,
  onChange,
  tokenCount,
  disabled,
  sourceLocale
}: TextInputProps) {
  const isOverLimit = tokenCount > TOKEN_LIMIT;
  const languageName = getSourceLanguageName(sourceLocale);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>{languageName} Text</Label>
        <Text
          variant={isOverLimit ? 'error' : 'secondary'}
          size="sm"
          bold={isOverLimit}
        >
          {tokenCount} / {TOKEN_LIMIT} {tokenCount === 1 ? 'token' : 'tokens'}
        </Text>
      </div>
      <InputArea
        value={value}
        onValueChange={onChange}
        placeholder={`Enter ${languageName} text to translate...`}
        disabled={disabled}
        rows={6}
        className="w-full"
      />
    </div>
  );
}
