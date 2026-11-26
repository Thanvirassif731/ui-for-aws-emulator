// Beginner bucket policy presets. Each returns pretty-printed JSON for the given bucket.
export const POLICY_PRESETS = [
  {
    id: 'public-read',
    label: 'Public Read-Only (Static Website Hosting)',
    summary: 'Anyone on the internet can download every object. This is what a public static website needs.',
    build: (bucket) => ({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/*`,
      }],
    }),
  },
  {
    id: 'deny-unencrypted',
    label: 'Deny Unencrypted Object Uploads (SSE-S3 Required)',
    summary: 'Refuses any PutObject that does not send x-amz-server-side-encryption: AES256. An explicit Deny beats every Allow.',
    build: (bucket) => ({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyUnencryptedObjectUploads',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'AES256' } },
      }],
    }),
  },
  {
    id: 'public-prefix',
    label: 'Allow Read Access Only to public/ Prefix',
    summary: 'Only keys that start with public/ are readable by everyone. Everything else stays private (implicit deny).',
    build: (bucket) => ({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'AllowPublicReadOnPublicPrefix',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/public/*`,
      }],
    }),
  },
];

export function presetPolicyText(id, bucket) {
  const preset = POLICY_PRESETS.find((item) => item.id === id);
  return preset ? JSON.stringify(preset.build(bucket), null, 2) : '';
}
