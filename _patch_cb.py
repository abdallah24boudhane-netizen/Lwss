path = "bot/callbacks.js"
s = open(path, encoding="utf-8").read()
old = "    { p: 'gp_jreq_',    fn: (ctx, d) => require('../handlers/group_join_requests').handleCallback(ctx, d) },"
if old not in s:
    print("❌ FAILED — راجع خطوة Join Requests")
else:
    new = old + "\n    { p: 'gp_topicdel_', fn: (ctx, d) => require('../handlers/group_topics').handleCallback(ctx, d) },"
    s = s.replace(old, new)
    open(path, "w", encoding="utf-8").write(s)
    print("✅ تمت إضافة بادئة gp_topicdel_")
