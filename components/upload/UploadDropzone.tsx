'use client';

import { FileSpreadsheet, Upload } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
  filename?: string | null;
  title?: string;
  description?: string;
}

export function UploadDropzone({ onFile, disabled, filename, title, description }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;

      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [disabled, onFile],
  );

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors',
        dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/30',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          // Reset so re-picking the same file still fires a change event.
          event.target.value = '';
        }}
      />

      {filename ? (
        <>
          <FileSpreadsheet className="size-8 text-primary" aria-hidden />
          <div>
            <p className="text-sm font-medium">{filename}</p>
            <p className="text-xs text-muted-foreground">Click or drop another file to replace it</p>
          </div>
        </>
      ) : (
        <>
          <Upload className="size-8 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">{title ?? 'Drop an XLS or XLSX file, or click to browse'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description ?? 'Uses spreadsheet columns for scraping'}</p>
          </div>
        </>
      )}
    </div>
  );
}
