import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PropertyFeaturesEditor from './PropertyFeaturesEditor.js';

// Helper: render with sensible defaults and capture the change callbacks.
function setup(overrides: Partial<React.ComponentProps<typeof PropertyFeaturesEditor>> = {}) {
  const onChange = vi.fn();
  const onInverseIriChange = vi.fn();
  const onDisjointChange = vi.fn();
  const props = {
    propertyType: 'object' as const,
    features: [] as string[],
    onChange,
    inverseIri: '',
    onInverseIriChange,
    disjointPropertyIris: [] as string[],
    onDisjointChange,
    availableProperties: [
      { name: 'hasPatient',  url: 'https://ex/p/1' },
      { name: 'hasCode',     url: 'https://ex/p/2' },
      // duplicate name (hasCode on a second domain) — must collapse to one option
      { name: 'hasCode',     url: 'https://ex/p/3' },
      { name: 'hasProvider', url: 'https://ex/p/4' },
    ],
    ...overrides,
  };
  const utils = render(<PropertyFeaturesEditor {...props} />);
  return { ...utils, onChange, onInverseIriChange, onDisjointChange };
}

describe('PropertyFeaturesEditor', () => {
  it('renders all 7 characteristic checkboxes for an object property', () => {
    setup({ propertyType: 'object' });
    for (const label of ['Functional', 'Inverse Functional', 'Transitive', 'Symmetric', 'Asymmetric', 'Reflexive', 'Irreflexive']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('shows only Functional for a datatype property (object-only features hidden)', () => {
    setup({ propertyType: 'datatype' });
    expect(screen.getByText('Functional')).toBeInTheDocument();
    expect(screen.queryByText('Transitive')).not.toBeInTheDocument();
    expect(screen.queryByText('Symmetric')).not.toBeInTheDocument();
  });

  it('toggling a characteristic calls onChange with the feature added', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ features: [] });
    await user.click(screen.getByRole('checkbox', { name: /^Functional/ }));
    expect(onChange).toHaveBeenCalledWith(['functional']);
  });

  it('does NOT render the Inverse-of row for a datatype property', () => {
    setup({ propertyType: 'datatype' });
    expect(screen.queryByText('Inverse of')).not.toBeInTheDocument();
  });

  it('deduplicates property names in the Inverse-of dropdown (hasCode once)', () => {
    setup();
    const inverseRow = screen.getByText('Inverse of').closest('div')!;
    const select = within(inverseRow).getByRole('combobox');
    const hasCodeOptions = within(select).getAllByRole('option').filter((o) => o.textContent === 'hasCode');
    expect(hasCodeOptions).toHaveLength(1);
  });

  it('Inverse-of is a single select (selecting one calls onInverseIriChange with the name)', async () => {
    const user = userEvent.setup();
    const { onInverseIriChange } = setup();
    const inverseRow = screen.getByText('Inverse of').closest('div')!;
    const select = within(inverseRow).getByRole('combobox');
    await user.selectOptions(select, 'hasPatient');
    expect(onInverseIriChange).toHaveBeenCalledWith('hasPatient');
  });

  it('adding a disjoint property from the schema dropdown calls onDisjointChange', async () => {
    const user = userEvent.setup();
    const { onDisjointChange } = setup({ disjointPropertyIris: [] });
    // the disjoint "+ from schema…" select is the one whose first option says so
    const selects = screen.getAllByRole('combobox');
    const disjointSelect = selects.find((s) => within(s).queryByText('+ from schema…'))!;
    await user.selectOptions(disjointSelect, 'hasPatient');
    expect(onDisjointChange).toHaveBeenCalledWith(['hasPatient']);
  });

  it('renders selected disjoint properties as removable pills', async () => {
    const user = userEvent.setup();
    const { onDisjointChange } = setup({ disjointPropertyIris: ['hasPatient'] });
    // the pill carries a single × remove button
    const removeBtn = screen.getByRole('button', { name: '×' });
    expect(removeBtn).toBeInTheDocument();
    await user.click(removeBtn);
    expect(onDisjointChange).toHaveBeenCalledWith([]);
  });

  it('previews the OWL output for selected features and references', () => {
    setup({ features: ['functional', 'transitive'], inverseIri: 'isPatientOf', disjointPropertyIris: ['hasProvider'] });
    expect(screen.getByText(/owl:FunctionalProperty/)).toBeInTheDocument();
    expect(screen.getByText(/owl:TransitiveProperty/)).toBeInTheDocument();
    expect(screen.getByText(/owl:inverseOf :isPatientOf/)).toBeInTheDocument();
    expect(screen.getByText(/owl:propertyDisjointWith :hasProvider/)).toBeInTheDocument();
  });

  it('formats an external (pasted IRI) disjoint reference as <iri> in the preview', () => {
    setup({ disjointPropertyIris: ['http://example.org/ext#rel'] });
    expect(screen.getByText(/owl:propertyDisjointWith <http:\/\/example\.org\/ext#rel>/)).toBeInTheDocument();
  });
});
