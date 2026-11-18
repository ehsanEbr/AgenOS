import { useTranslation } from 'react-i18next';
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, SLUG_MIN_LENGTH, type FieldProblem } from './form-rules';
import { SLUG_MAX_LENGTH } from './slug';

/** Turns a pure field check into an Ant Design form rule whose error text is translated. */
export function useFieldRule() {
  const { t } = useTranslation('projects');
  return (problem: (value: unknown) => FieldProblem | null) => ({
    validator: async (_: unknown, value: unknown) => {
      const found = problem(value);
      if (found) {
        const max =
          found === 'slugTooLong'
            ? SLUG_MAX_LENGTH
            : found === 'nameTooLong'
              ? NAME_MAX_LENGTH
              : DESCRIPTION_MAX_LENGTH;
        throw new Error(t(`fields.${found}`, { min: SLUG_MIN_LENGTH, max }));
      }
    },
  });
}
