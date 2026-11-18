import {useVirtualizer} from '@tanstack/react-virtual';
import {useRef} from 'react';

import {type DataTableProps, TableFrame} from './table';
import {spacerSizes} from './virtual-rows';

/**
 * A long DataTable (`virtualize`, at least VIRTUAL_MIN_ROWS rows), windowed: only the rows in view are drawn inside a
 * scrolling region. Its own chunk, loaded by DataTable only when a table needs it (keeps @tanstack/virtual-core out of
 * the shared UI chunk). Not exported from the kit's barrel: use `<DataTable virtualize>`.
 */
export default function VirtualTable<Row>(props: DataTableProps<Row>) {
  const {rows, rowKey, virtualize} = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => virtualize?.estimate ?? 48,
    overscan: 8,
    getItemKey: index => (rows ? rowKey(rows[index]!) : index),
  });
  const items = virtualizer.getVirtualItems();
  return (
    <TableFrame
      {...props}
      win={{scrollRef, indexes: items.map(item => item.index), spacer: spacerSizes(items, virtualizer.getTotalSize()), measure: virtualizer.measureElement}}
    />
  );
}
