import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MappingBoard from './MappingBoard.js';
import type { MatchReport } from '../api/matching.js';
import { apiClient } from '../api/client.js';

// jsdom implements no real DataTransfer — a minimal setData/getData stand-in
// is enough to drive the same onDragStart/onDrop handlers a real drag fires.
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => { store[type] = value; },
    getData: (type: string) => store[type] ?? '',
    effectAllowed: '',
  } as unknown as DataTransfer;
}

// Reproduces the real ambiguous-date case found earlier this session:
// condition_end_datetime and condition_start_datetime both share the
// Process::atTime>[*]>hasValue::xsd:dateTime shape, so the board must seed
// one as an unconfirmed suggestion rather than silently picking the wrong one.
const REPORT: MatchReport = {
  sourceSchema: { id: 'src', title: 'OMOP CDM Schema' },
  targetSchema: { id: 'tgt', title: 'MIMIC-IV FHIR Demo Schema' },
  matched: [
    {
      key: 'k1',
      domainCategory: 'Process',
      shape: 'atTime>[*]>hasValue',
      rangeCategory: 'xsd:dateTime',
      source: [
        { schemaId: 'src', className: 'ConditionOccurrence', propertyId: 'end-dt', propertyName: 'condition_end_datetime', propertyType: 'datatype', domainCategory: 'Process', rangeDescription: 'xsd:dateTime', rangeCategory: 'xsd:dateTime', shape: 'atTime>[EndTime]>hasValue' },
        { schemaId: 'src', className: 'ConditionOccurrence', propertyId: 'start-dt', propertyName: 'condition_start_datetime', propertyType: 'datatype', domainCategory: 'Process', rangeDescription: 'xsd:dateTime', rangeCategory: 'xsd:dateTime', shape: 'atTime>[StartTime]>hasValue' },
      ],
      target: [
        { schemaId: 'tgt', className: 'Condition', propertyId: 'recorded-date', propertyName: 'hasRecordedDate', propertyType: 'datatype', domainCategory: 'Process', rangeDescription: 'xsd:dateTime', rangeCategory: 'xsd:dateTime', shape: 'atTime>[TimeInstant]>hasValue' },
      ],
    },
  ],
  sourceOnly: [],
  targetOnly: [],
};

function renderBoard() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MappingBoard report={REPORT} />
    </QueryClientProvider>,
  );
}

describe('MappingBoard drag-and-drop', () => {
  it('seeds the ambiguous pair from the first candidate and flags it as an unconfirmed suggestion', () => {
    renderBoard();
    const row = screen.getByText(/Condition\.hasRecordedDate/).closest('div.grid')!;
    expect(row.textContent).toContain('condition_end_datetime');
    // dashed amber border class marks it as a suggestion, not a confirmed pick
    const dropZone = row.querySelector('.border-dashed')!;
    expect(dropZone.innerHTML).toContain('border-amber-300');
  });

  it('dragging a different source chip onto the row overrides the seeded (wrong) suggestion', () => {
    renderBoard();

    const row = () => screen.getByText(/Condition\.hasRecordedDate/).closest('div.grid')!;
    expect(row().textContent).toContain('condition_end_datetime');

    // the pool chip for the OTHER candidate
    const startChip = screen.getByText((_, el) => el?.textContent === 'ConditionOccurrence.condition_start_datetime' && el.tagName === 'DIV');
    const dropZone = row().querySelector('[class*="border-dashed"], [class*="border-2"]')!;

    const dt = makeDataTransfer();
    fireEvent.dragStart(startChip, { dataTransfer: dt });
    fireEvent.dragOver(dropZone, { dataTransfer: dt });
    fireEvent.drop(dropZone, { dataTransfer: dt });

    expect(row().textContent).toContain('condition_start_datetime');
    expect(row().textContent).not.toContain('condition_end_datetime');
    // no longer a suggestion once explicitly dropped
    expect(row().querySelector('.border-amber-300')).toBeNull();
  });

  it('enables "Generate CONSTRUCT queries" once a pair exists, with the overridden pairing', () => {
    renderBoard();
    const button = screen.getByRole('button', { name: /Generate CONSTRUCT queries/ });
    expect(button).not.toBeDisabled();
    expect(button.textContent).toContain('1 pair');
  });
});

describe('MappingBoard value transforms', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picking "Cast type…" reveals a datatype selector, and the choice is sent to /construct', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { pairs: [] } });
    renderBoard();

    const transformSelect = screen.getByLabelText('Transform operation') as HTMLSelectElement;
    fireEvent.change(transformSelect, { target: { value: 'cast' } });

    const castSelect = screen.getByLabelText('Cast datatype') as HTMLSelectElement;
    fireEvent.change(castSelect, { target: { value: 'dateTime' } });

    fireEvent.click(screen.getByRole('button', { name: /Generate CONSTRUCT queries/ }));

    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(spy).toHaveBeenCalledWith(
      '/matching/construct',
      expect.objectContaining({
        pairs: [expect.objectContaining({ transform: { kind: 'cast', datatype: 'dateTime' } })],
      }),
    );
  });

  it('dropping a different source chip resets any transform already configured on that row', () => {
    renderBoard();

    const transformSelect = screen.getByLabelText('Transform operation') as HTMLSelectElement;
    fireEvent.change(transformSelect, { target: { value: 'uppercase' } });
    expect((screen.getByLabelText('Transform operation') as HTMLSelectElement).value).toBe('uppercase');

    const row = () => screen.getByText(/Condition\.hasRecordedDate/).closest('div.grid')!;
    const startChip = screen.getByText((_, el) => el?.textContent === 'ConditionOccurrence.condition_start_datetime' && el.tagName === 'DIV');
    const dropZone = row().querySelector('[class*="border-dashed"], [class*="border-2"]')!;

    const dt = makeDataTransfer();
    fireEvent.dragStart(startChip, { dataTransfer: dt });
    fireEvent.dragOver(dropZone, { dataTransfer: dt });
    fireEvent.drop(dropZone, { dataTransfer: dt });

    expect((screen.getByLabelText('Transform operation') as HTMLSelectElement).value).toBe('none');
  });
});
