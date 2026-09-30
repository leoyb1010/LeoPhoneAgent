#!/usr/bin/env python3
"""Compile actual setSession/createTab methods with deterministic Android adapters."""
import pathlib, subprocess, sys, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
s = (root/'app/src/main/java/com/leoyuan/leophoneagent/browser/BrowserTabPool.kt').read_text()
transition=s[s.index('    fun setSession('):s.index('    // -- Downloads')]
factory=s[s.index('    private fun createTab('):s.index('    // -- Tab Management Actions')]
fixture='''
class Box<T>(var value:T)
class Job { fun cancel() {} }
class WebView(val context:Int) { var destroyed=false; fun stopLoading() {}; fun destroy(){destroyed=true} }
enum class UserAgentProfile { MOBILE_CHROME, CUSTOM }
class BrowserUseManager(val webView:WebView,val owner:String?,val profile:UserAgentProfile) {
 val currentURL=Box(""); var onNewWindow:((Int)->Unit)?=null;var onCloseWindow:(()->Unit)?=null;var onDownloadStart:(()->Unit)?=null
 fun setUserAgent(p:UserAgentProfile,s:String?){};fun applyViewport(w:Int,h:Int){};fun loadURL(url:String){currentURL.value=url}
}
class Tab(val id:Int,val manager:BrowserUseManager){var inUseGraceJob:Job?=null;var needsInitialBlankPage=false}
object Dispatchers {object Main {val immediate=0}}
class Scope {fun launch(dispatcher:Int,block:()->Unit){block()}}
object Log {fun i(tag:String,msg:String){}}
data class Snapshot(val urls:Map<Int,String>,val selected:Int,val next:Int)
class BrowserTabPool {
 val context=0;val TAG="test";val MAX_TABS=3;var userAgentProfile=UserAgentProfile.MOBILE_CHROME;var customUserAgentString:String?=null
 var sessionId:String?="draft";val _tabs=Box<List<Tab>>(emptyList());var nextTabId=0;val _selectedTabId=Box(0)
 val _sessionViewportWidth=Box(0);val _sessionViewportHeight=Box(0);val savedURLs=mutableMapOf<Int,String>();val evictionScope=Scope()
 val persisted=mutableMapOf<String,Snapshot>()
 fun saveState(){sessionId?.let{persisted[it]=Snapshot(savedURLs+_tabs.value.associate{t->t.id to t.manager.currentURL.value},_selectedTabId.value,nextTabId)}}
 fun loadSavedState(){persisted[sessionId]?.let{savedURLs.putAll(it.urls);_selectedTabId.value=it.selected;nextTabId=maxOf(it.next,(it.urls.keys.maxOrNull()?:-1)+1)}}
 fun resolvedViewportSize()=Pair(100,100);fun handleNewWindow(msg:Int){};fun handleCloseWindow(m:BrowserUseManager){};fun wireDownloadHandlers(m:BrowserUseManager){}
 fun seed(vararg ids:Int){_tabs.value=ids.map{Tab(it,BrowserUseManager(WebView(0),"draft",userAgentProfile).apply{loadURL("https://tab-$it.example")})}}
 fun new(url:String?=null):Tab?=createTab(_tabs.value.toMutableList(),url)
''' + transition + factory + '''
}
fun main(){
 val sparse=BrowserTabPool();sparse.seed(1);sparse.nextTabId=2;sparse._selectedTabId.value=1
 sparse.persisted["real"]=Snapshot(mapOf(1 to "https://tab-1.example"),1,2)
 val old=sparse._tabs.value[0].manager.webView;sparse.setSession("real",migrateExisting=true)
 check(sparse._tabs.value.map{it.id}==listOf(1));check(sparse.savedURLs.isEmpty());check(sparse._selectedTabId.value==1);check(sparse.nextTabId==2)
 check(sparse._tabs.value[0].manager.owner=="real");check(old.destroyed)
 val added=sparse.new()!!;check(added.id==2&&added.needsInitialBlankPage)
 val multi=BrowserTabPool();multi.seed(2,7);multi.nextTabId=9;multi._selectedTabId.value=7;multi.savedURLs[8]="https://evicted.example"
 multi.persisted["real"]=Snapshot(mapOf(0 to "https://stale.example"),0,1);multi.setSession("real",true)
 check(multi._tabs.value.map{it.id}==listOf(2,7));check(multi._selectedTabId.value==7);check(multi.savedURLs==mapOf(8 to "https://evicted.example"));check(multi.new("https://new.example")!!.id==9)
 val evicted=BrowserTabPool();evicted.savedURLs.putAll(mapOf(4 to "https://four.example",11 to "https://eleven.example"));evicted._selectedTabId.value=11;evicted.nextTabId=12
 evicted.setSession("real",true);check(evicted.new()!!.id==11);check(evicted.new()!!.id==12);check(evicted.savedURLs.keys==setOf(4))
 val reopened=BrowserTabPool();reopened.sessionId=null;reopened.persisted["real"]=Snapshot(mapOf(4 to "https://four.example"),4,9)
 reopened.setSession("real");check(reopened.new()!!.id==4);check(reopened.new()!!.id==9)
 val blank=BrowserTabPool();blank.seed(0);blank._tabs.value[0].manager.currentURL.value="";blank.nextTabId=1;blank.setSession("real",true)
 check(blank._tabs.value[0].id==0&&blank._tabs.value[0].needsInitialBlankPage)
 val owner=reopened._tabs.value[0].manager;reopened.setSession("real");check(reopened._tabs.value[0].manager===owner)
 println("ANDROID_BROWSER_SESSION_OK sparse/multiple/selected/evicted/reopened/migrated IDs and next-ID")
}
'''
with tempfile.TemporaryDirectory(prefix='leophone-tabs-') as tmp:
    src=pathlib.Path(tmp)/'BrowserSessionSmoke.kt';jar=pathlib.Path(tmp)/'test.jar';src.write_text(fixture)
    subprocess.run([sys.argv[1],str(src),'-include-runtime','-d',str(jar)],check=True)
    subprocess.run(['java','-jar',str(jar)],check=True)
