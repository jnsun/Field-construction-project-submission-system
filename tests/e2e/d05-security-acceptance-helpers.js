const SAFE_DEFINER_SEARCH_PATHS = [
  'search_path=pg_catalog',
  'search_path=public',
  'search_path=public, extensions',
  'search_path=public, vault',
];

function securityDefinerHasSafePathSql(alias = 'p') {
  const allowed = SAFE_DEFINER_SEARCH_PATHS
    .map(value => `'${value.replaceAll("'", "''")}'`)
    .join(', ');
  return `EXISTS (
    SELECT 1
    FROM unnest(COALESCE(${alias}.proconfig, ARRAY[]::text[])) item
    WHERE item = ANY (ARRAY[${allowed}]::text[])
  )`;
}

module.exports = {
  SAFE_DEFINER_SEARCH_PATHS,
  securityDefinerHasSafePathSql,
};
