'use strict';
const { cacheGet, cacheSet, cacheClearPrefix, cacheClear } = require('../utils/cache');
const filesDb = require('../database/files');
const { parseQuery, scoreFile } = require('../utils/searchParser');
const SEARCH_SVC = process.env.SEARCH_SERVICE_URL || 'http://localhost:3001';
const USE_GO_SEARCH = process.env.DISABLE_GO_SEARCH !== "1";
function _getCached(key){return cacheGet('gsrc_'+key);}
function _setCached(key,data){cacheSet('gsrc_'+key,data,300000);}
async function _goSearch(q,limit){
  if(!USE_GO_SEARCH)return null;
  try{
    const ctrl=new AbortController();
    const tid=setTimeout(()=>ctrl.abort(),1500);
    const res=await fetch(`${SEARCH_SVC}/search?q=${encodeURIComponent(q)}&limit=${limit}`,{signal:ctrl.signal});
    clearTimeout(tid);
    if(res.ok)return await res.json();
  }catch(_){}
  return null;
}
async function smartSearch(rawQ,limit){
  limit=limit||15;
  const{terms,raw,groups}=parseQuery(rawQ);
  if(!terms.length)return[];
  const cacheKey=raw.slice(0,60);
  const cached=_getCached(cacheKey);
  if(cached)return cached;
  const allResults=new Map();
  const goRes=await _goSearch(raw,limit*2);
  if(goRes&&goRes.length)goRes.forEach(f=>allResults.set(f.id,f));
  const pgTerms=[...new Set([raw,...terms])].slice(0,4);
  const pgResults=await Promise.all(pgTerms.map(t=>filesDb.search(t,limit).catch(()=>[])));
  for(const arr of pgResults)arr.forEach(f=>{if(!allResults.has(f.id))allResults.set(f.id,f);});

  // تحقق من كل النتائج ضد قاعدة البيانات الحية (Go service قد يرجع نتائج قديمة/محذوفة)
  const idsToVerify = [...allResults.keys()];
  if (idsToVerify.length) {
    const { all: _dbAll } = require('../database/db');
    const liveRows = await _dbAll(
      `SELECT f.id, s.name as sub_name, sp.name as specialty_name
       FROM files f
       JOIN categories c ON f.category_id=c.id
       JOIN subjects s ON c.subject_id=s.id
       JOIN semesters sm ON s.semester_id=sm.id
       JOIN years y ON sm.year_id=y.id
       JOIN specialties sp ON y.specialty_id=sp.id
       WHERE f.id = ANY($1::int[]) AND f.is_deleted=0`,
      [idsToVerify]
    ).catch(() => null);
    if (liveRows) {
      const liveMap = new Map(liveRows.map(r => [r.id, r]));
      for (const id of idsToVerify) {
        const row = liveMap.get(id);
        if (!row) { allResults.delete(id); continue; }
        const f = allResults.get(id);
        f.sub_name = row.sub_name;
        f.specialty_name = row.specialty_name;
      }
    }
  }

  const final=[...allResults.values()]
    .map(f=>({f,s:scoreFile(f,terms,groups)}))
    .filter(x=>x.s>0)
    .sort((a,b)=>b.s-a.s)
    .slice(0,limit)
    .map(x=>x.f);
  _setCached(cacheKey,final,900000);
  return final;
}
function invalidateSearchCache(){
  cacheClearPrefix('search_');cacheClearPrefix('gsrc_');
  cacheClear('latest_15');cacheClear('popular_15');
  if(USE_GO_SEARCH)fetch(`${SEARCH_SVC}/reindex`,{method:'POST'}).catch(err => { require('../utils/logger').debug("[silent]", err.message); });
}
global._clearSearchCache=invalidateSearchCache;
module.exports={smartSearch,invalidateSearchCache};
