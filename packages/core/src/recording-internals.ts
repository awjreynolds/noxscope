const importedRecords = new WeakSet<object>();

export function markImportedRecordingRecord(record: object): void {
  importedRecords.add(record);
}

export function isImportedRecordingRecord(record: object): boolean {
  return importedRecords.has(record);
}
