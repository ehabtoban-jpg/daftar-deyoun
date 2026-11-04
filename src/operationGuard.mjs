export type OperationRecord = {
  id?: unknown
  type?: unknown
  trashId?: unknown
  appliedBy?: unknown
}

export function assertMatchingTrashRestoreOperation(
  operation: OperationRecord,
  operationId: string,
  trashId: string,
  userId: string,
): void {
  if (
    operation.id !== operationId ||
    operation.type !== 'trash-restore' ||
    operation.trashId !== trashId ||
    operation.appliedBy !== userId
  ) {
    throw new Error('OPERATION_ID_CONFLICT')
  }
}
