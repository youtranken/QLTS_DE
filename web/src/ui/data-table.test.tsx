import { describe, it, expect, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './data-table';
import {
  renderWithI18n,
  screen,
  within,
  waitFor,
  userEvent,
} from '../test/test-utils';

interface Row {
  name: string;
  qty: number;
}
const DATA: Row[] = [
  { name: 'Banana', qty: 3 },
  { name: 'apple', qty: 10 },
  { name: 'Cherry', qty: 1 },
];
const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Tên' },
  { accessorKey: 'qty', header: 'SL' },
  { id: 'act', header: 'Hành động', enableSorting: false, cell: () => <button>x</button> },
];

/** Tên ở cột đầu của từng dòng body (bỏ dòng header). */
function rowNames(): (string | null)[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent);
}

describe('DataTable', () => {
  it('render đủ dòng + cột', () => {
    renderWithI18n(<DataTable data={DATA} columns={COLUMNS} emptyText="Trống" />);
    expect(screen.getByText('Banana')).toBeInTheDocument();
    expect(rowNames()).toEqual(['Banana', 'apple', 'Cherry']);
  });

  it('bấm header cột sắp xếp: asc → desc → về nguyên bản', async () => {
    renderWithI18n(<DataTable data={DATA} columns={COLUMNS} emptyText="Trống" />);
    const slHeader = screen.getByRole('button', { name: /SL/ });
    await userEvent.click(slHeader);
    expect(rowNames()).toEqual(['Cherry', 'Banana', 'apple']); // 1,3,10
    await userEvent.click(slHeader);
    expect(rowNames()).toEqual(['apple', 'Banana', 'Cherry']); // 10,3,1
    await userEvent.click(slHeader);
    expect(rowNames()).toEqual(['Banana', 'apple', 'Cherry']); // nguyên bản
  });

  it('th mang aria-sort phản ánh trạng thái sắp xếp', async () => {
    renderWithI18n(<DataTable data={DATA} columns={COLUMNS} emptyText="Trống" />);
    const slHeaderCell = screen.getByText('SL').closest('th')!;
    expect(slHeaderCell).not.toHaveAttribute('aria-sort');
    await userEvent.click(screen.getByRole('button', { name: /SL/ }));
    expect(slHeaderCell).toHaveAttribute('aria-sort', 'ascending');
  });

  it('cột enableSorting=false không cho bấm sắp xếp', async () => {
    renderWithI18n(<DataTable data={DATA} columns={COLUMNS} emptyText="Trống" />);
    // header "Hành động" không được bọc trong button
    expect(screen.getByText('Hành động').closest('button')).toBeNull();
  });

  it('ô tìm kiếm lọc dòng theo nội dung (debounce)', async () => {
    renderWithI18n(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        emptyText="Trống"
        searchPlaceholder="Tìm"
      />,
    );
    await userEvent.type(screen.getByLabelText('Tìm'), 'app');
    // apple luôn hiện (cả khi chưa lọc) → phải đợi Banana BIẾN MẤT sau debounce, không đợi apple.
    await waitFor(() =>
      expect(screen.queryByText('Banana')).not.toBeInTheDocument(),
    );
    expect(rowNames()).toEqual(['apple']);
  });

  it('data rỗng → hiện emptyText', () => {
    renderWithI18n(<DataTable data={[]} columns={COLUMNS} emptyText="Chưa có dữ liệu" />);
    expect(screen.getByText('Chưa có dữ liệu')).toBeInTheDocument();
  });

  it('rowClassName gán class <tr> theo dữ liệu dòng', () => {
    renderWithI18n(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        emptyText="Trống"
        rowClassName={(r) => (r.qty > 5 ? 'hot' : '')}
      />,
    );
    expect(screen.getByText('apple').closest('tr')).toHaveClass('hot'); // qty 10
    expect(screen.getByText('Banana').closest('tr')).not.toHaveClass('hot');
  });

  it('manualSorting: bấm header gọi onSortingChange, KHÔNG sắp client', async () => {
    const onSortingChange = vi.fn();
    renderWithI18n(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        emptyText="Trống"
        manualSorting
        sorting={[]}
        onSortingChange={onSortingChange}
      />,
    );
    expect(rowNames()).toEqual(['Banana', 'apple', 'Cherry']);
    await userEvent.click(screen.getByRole('button', { name: /SL/ }));
    expect(onSortingChange).toHaveBeenCalled();
    // giữ nguyên thứ tự — server sẽ trả data đã sắp, client không tự sắp
    expect(rowNames()).toEqual(['Banana', 'apple', 'Cherry']);
  });

  it('onRowClick: bấm dòng gọi callback; nút stopPropagation thì không', async () => {
    const onRowClick = vi.fn();
    const cols: ColumnDef<Row>[] = [
      { accessorKey: 'name', header: 'Tên' },
      {
        id: 'act',
        header: '',
        enableSorting: false,
        cell: () => <button onClick={(e) => e.stopPropagation()}>x</button>,
      },
    ];
    renderWithI18n(
      <DataTable data={DATA} columns={cols} emptyText="Trống" onRowClick={onRowClick} />,
    );
    await userEvent.click(screen.getByText('Banana'));
    expect(onRowClick).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Banana' }),
    );
    onRowClick.mockClear();
    await userEvent.click(screen.getAllByText('x')[0]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('tableClassName nối thêm vào <table>', () => {
    const { container } = renderWithI18n(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        emptyText="Trống"
        tableClassName="board-table"
      />,
    );
    expect(container.querySelector('table')).toHaveClass('table', 'board-table');
  });
});
