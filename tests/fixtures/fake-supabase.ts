// In-memory stand-in for the slice of supabase-js that bk-media's list path uses (tests only).
type Row = Record<string, any>;
export const fake = {
  tables: {} as Record<string, Row[]>,
  objects: new Set<string>(),
  signed: [] as string[], // every storage path anyone asked to sign
  failTable: null as string | null,
  reset(tables: Record<string, Row[]>, objects: string[]) {
    this.tables = structuredClone(tables);
    this.objects = new Set(objects);
    this.signed.length = 0;
  },
};
const signedUrl = (path: string, download?: string) =>
  `https://fake.supabase.test/storage/v1/object/sign/project-media/${path}?token=t${download ? `&download=${encodeURIComponent(download)}` : ""}`;

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const run = () => {
    if (fake.failTable === table) return { data: null, error: { message: "boom" } };
    return { data: (fake.tables[table] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
  };
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
    maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

export function createClient(_url: string, _key: string) {
  return {
    from: (t: string) => query(t),
    rpc: async () => ({ data: null, error: { message: "not_in_fake" } }),
    auth: {
      getUser: async (jwt: string) => ({ data: { user: jwt === "aaa.staff.jwt" ? { id: "staff-uid", email: "nelson@x.test" } : null } }),
    },
    storage: {
      from: (_bucket: string) => ({
        createSignedUrls: async (paths: string[]) => {
          fake.signed.push(...paths);
          return { data: paths.map((p) => fake.objects.has(p)
            ? { path: p, signedUrl: signedUrl(p), error: null }
            : { path: p, signedUrl: null, error: "Object not found" }), error: null };
        },
        createSignedUrl: async (p: string, _ttl: number, o?: { download?: string }) => {
          fake.signed.push(p);
          return fake.objects.has(p) ? { data: { signedUrl: signedUrl(p, o?.download) }, error: null } : { data: null, error: { message: "Object not found" } };
        },
      }),
    },
  };
}
