import { useTranslation } from 'react-i18next';
import { NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH, type FieldProblem } from './form-rules';

/** Turns a pure field check into an Ant Design form rule whose error text is translated. */
export function useFieldRule() {
  const { t } = useTranslation('auth');
  return (problem: (value: unknown) => FieldProblem | null) => ({
    validator: async (_: unknown, value: unknown) => {
      const found = problem(value);
      if (found) throw new Error(t(`fields.${found}`, { min: PASSWORD_MIN_LENGTH, max: NAME_MAX_LENGTH }));
    },
  });
}
