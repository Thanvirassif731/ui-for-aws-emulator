import { awsJsonCall, ServiceError } from './aws-json.js';

const call = (operation, input) => awsJsonCall({ signingName: 'dynamodb', target: `DynamoDB_20120810.${operation}`, input });

export async function listTables() {
  const names = [];
  let start;
  do {
    const result = await call('ListTables', { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) });
    names.push(...(result.TableNames || []));
    start = result.LastEvaluatedTableName;
  } while (start && names.length < 1000);
  return names;
}

export async function scanTable(tableName, exclusiveStartKey) {
  if (!tableName || typeof tableName !== 'string') throw new ServiceError('Table name is required');
  const result = await call('Scan', {
    TableName: tableName,
    Limit: 100,
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  });
  return {
    items: result.Items || [],
    count: result.Count || 0,
    scannedCount: result.ScannedCount || 0,
    nextKey: result.LastEvaluatedKey || null,
  };
}
