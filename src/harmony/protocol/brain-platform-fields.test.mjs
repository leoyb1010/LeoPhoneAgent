import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root = new URL('../app/entry/src/main/ets/local/', import.meta.url);
const load = name => fs.readFileSync(new URL(name, root), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '');
const clone = value => JSON.parse(JSON.stringify(value));
let foreground = true;
let current = true;
let allowWrite = true;
let permissionWait;
let readWait;
let submittedWrite;
let reads = 0;
let writes = 0;
let permissionCalls = 0;
const approvals = [];
const base = Date.parse('2026-11-09T08:00:00+08:00');
const originalContact = {
  id: 8, key: 'contact-key', name: {fullName:'张 伟',givenName:'伟',familyName:'张',middleName:'保留'},
  organization:{name:'Example Corp',title:'Engineer'},note:{noteContent:'original note'},
  phoneNumbers:[{phoneNumber:'100',labelName:'work',custom:'keep'},{phoneNumber:'200',labelName:'home'}],
  emails:[{email:'old@example.test',labelName:'work'}],groups:[{groupId:7,title:'Team'}],
  postalAddresses:[{postalAddress:'original address',city:'Old City'}],
  events:[{eventDate:'2001-01-01',labelId:1},{eventDate:'1960-01-01',labelId:3}],
  websites:[{website:'https://example.test'}],futureField:{retained:true},
};
let storedContact = clone(originalContact);
let lastAttributes;
const eventStore = new Map([
  [1,[{id:11,type:0,title:'Personal',startTime:base+3600000,endTime:base+3*3600000,
    description:'original notes',location:{location:'Old Room',latitude:10,longitude:20},timeZone:'Asia/Shanghai',
    attendee:[{name:'Person',email:'person@example.test'}],identifier:'keep-source'}]],
  [2,[{id:22,type:0,title:'Work',startTime:base+2*3600000,endTime:base+4*3600000},
    {id:33,type:0,title:'Recurring',startTime:base+6*3600000,endTime:base+7*3600000,
      recurrenceRule:{recurrenceFrequency:3,interval:1},description:'keep recurring notes'}]],
]);
let lastEvent;
const calendars = [1,2].map(id => ({id,getAccount:()=>({name:id===1?'Personal':'Work',type:'local'}),
  async getEvents(filter) {reads++;if(readWait)await readWait;return clone(eventStore.get(id).filter(e=>filter.ids.includes(e.id)));},
  async queryEventInstances(start,end) {reads++;return clone(eventStore.get(id).filter(e=>e.endTime>start&&e.startTime<end));},
  async addEvent(event) {writes++;if(submittedWrite)await submittedWrite;return 90;},
  async updateEvent(event) {writes++;lastEvent=clone(event);},
  async deleteEvent() {writes++;},async openEventEditPage() {writes++;},
}));
const kitContact = {
  Attribute: Object.fromEntries(['NAME','ORGANIZATION','NICKNAME','NOTE','PHONE','EMAIL','POSTAL_ADDRESS','CONTACT_EVENT'].map((name,index)=>['ATTR_'+name,index])),
  PhoneNumber:{CUSTOM_LABEL:0,NUM_MOBILE:2},Email:{CUSTOM_LABEL:0,EMAIL_OTHER:3},
  PostalAddress:{CUSTOM_LABEL:0},Event:{EVENT_BIRTHDAY:3},
  async queryContacts() {reads++;if(readWait)await readWait;return [clone(storedContact)];},
  async queryContact(_context,key) {reads++;if(readWait)await readWait;assert.equal(key,'contact-key');return clone(storedContact);},
  async queryGroups() {reads++;return [{groupId:7,title:'Team'}];},
  async addContact(_context,entry) {writes++;storedContact={...clone(entry),key:'new-key',id:9};return 9;},
  async updateContact(_context,entry,attributes) {writes++;storedContact=clone(entry);lastAttributes=clone(attributes);},
  async deleteContact() {writes++;},
};
const reminder = {reminderId:0,reminderReq:{reminderType:1,title:'Old reminder',content:'keep note',
  dateTime:{year:2027,month:1,day:1,hour:9,minute:0,second:0},wantAgent:{opaque:'preserve'},notificationId:42}};
let lastReminder;
const environment = {
  console,Date,Intl,intl:{DateTimeFormat:Intl.DateTimeFormat},
  AppStorage:{get:()=>foreground},WRITE_GRANT_MARK:'__GRANT__',
  toolArg:(raw,key)=>`${JSON.parse(raw)[key]??''}`,
  SensitiveToolGate:{consumeWriteGrant(owner){approvals.push(owner);return allowWrite&&owner==='owner';}},
  abilityAccessCtrl:{createAtManager:()=>({checkAccessTokenSync:()=>0,
    async requestPermissionsFromUser(_context,permissions){permissionCalls++;if(permissionWait)await permissionWait;return{authResults:permissions.map(()=>0)};}})},
  contact:kitContact,
  calendarManager:{EventType:{NORMAL:0},EventFilter:{filterById:ids=>({ids})},getCalendarManager:()=>({getCalendar:async()=>calendars[0],getAllCalendars:async()=>calendars})},
  reminderAgentManager:{ReminderType:{REMINDER_TYPE_CALENDAR:1},getAllValidReminders:async()=>[clone(reminder)],
    async updateReminder(id,request){assert.equal(id,0);writes++;lastReminder=clone(request);},
    async cancelReminder(id){assert.equal(id,0);writes++;},async publishReminder(){writes++;return 0;}},
};
const context = vm.createContext(environment);
vm.runInContext(stripTypeScriptTypes(load('ExtraToolSchemas.ets')+'\n'+load('PlatformTools.ets'),{mode:'strip'})+'\nglobalThis.Tools=PlatformTools;',context);
const tools=context.Tools;
const ui={startAbility(){},applicationInfo:{accessTokenId:123}};
const run=(name,args={},owner='owner',unattended=false)=>tools.run(ui,name,JSON.stringify(args),owner,unattended,()=>current);

const permissionBeforeStatus=permissionCalls;
assert.equal(JSON.parse(await run('contacts_status')).read,true);
assert.equal(JSON.parse(await run('calendar_status')).write,true);
assert.equal(permissionCalls,permissionBeforeStatus);
assert.equal(JSON.parse(await run('contacts_groups'))[0].title,'Team');
assert.equal(JSON.parse(await run('contacts_search',{query:'张伟'}))[0].key,'contact-key');
assert.equal(JSON.parse(await run('contacts_search',{query:'old@example',group:'Team'}))[0].organization,'Example Corp');
assert.equal(JSON.parse(await run('contacts_get',{key:'contact-key'})).note,'original note');
await run('contacts_update',{key:'contact-key',phone:'300'});
assert.equal(storedContact.phoneNumbers[0].phoneNumber,'300');
assert.equal(storedContact.phoneNumbers[1].phoneNumber,'200');
assert.equal(storedContact.phoneNumbers[0].custom,'keep');
assert.deepEqual(storedContact.emails,originalContact.emails);
assert.deepEqual(storedContact.note,originalContact.note);
assert.deepEqual(storedContact.futureField,originalContact.futureField);
assert.deepEqual(lastAttributes.attributes,[kitContact.Attribute.ATTR_PHONE]);
await run('contacts_update',{key:'contact-key',phones:'[]',emails:'[{"value":"new@example.test","label":"work"}]',birthday:'1950-02-03'});
assert.deepEqual(storedContact.phoneNumbers,[]);
assert.equal(storedContact.emails[0].email,'new@example.test');
assert.equal(storedContact.events.find(e=>e.labelId===3).eventDate,'1950-02-03');
assert.equal(storedContact.events.find(e=>e.labelId===1).eventDate,'2001-01-01');
assert.deepEqual(storedContact.postalAddresses,originalContact.postalAddresses);
const countBeforeInvalid=writes;
await assert.rejects(run('contacts_update',{key:'contact-key',emails:'["invalid"]'}),/邮箱/);
assert.equal(writes,countBeforeInvalid);
assert.equal(JSON.parse(await run('contacts_update',{key:'contact-key',unsupported_field:'value'})).status,'unsupported');
assert.equal(writes,countBeforeInvalid);
await run('calendar_update',{calendar_id:'1',id:'11',title:'Updated',location:'New Room'});
assert.equal(lastEvent.title,'Updated');
assert.equal(lastEvent.description,'original notes');
assert.equal(lastEvent.location.latitude,10);
assert.equal(lastEvent.identifier,'keep-source');
assert.deepEqual(lastEvent.attendee,eventStore.get(1)[0].attendee);
const countBeforeScope=writes;
assert.equal(JSON.parse(await run('calendar_update',{calendar_id:'2',id:'33',title:'Change'})).status,'unsupported');
assert.equal(writes,countBeforeScope);
await run('calendar_update',{calendar_id:'2',id:'33',span:'all',title:'Series Updated'});
assert.equal(lastEvent.recurrenceRule.interval,1);
assert.equal(lastEvent.description,'keep recurring notes');
const beforeMove=writes;
assert.equal(JSON.parse(await run('calendar_update',{id:'11',title:'Move',target_calendar_id:'2'})).status,'unsupported');
assert.equal(writes,beforeMove);
const listed=JSON.parse(await run('calendar_list',{start:String(base),end:String(base+10*3600000)}));
assert.ok(listed.some(e=>e.calendar_id===1)&&listed.some(e=>e.calendar_id===2));
const availability=JSON.parse(await run('calendar_freebusy',{start:String(base),end:String(base+10*3600000)}));
assert.equal(availability.busy[0].start,base+3600000);
assert.equal(availability.busy[0].end,base+4*3600000);
assert.equal(availability.availability_field,'not_exposed_by_CalendarKit');
await run('calendar_reminder_update',{id:'0',title:'New reminder'});
assert.equal(lastReminder.content,'keep note');
assert.equal(lastReminder.wantAgent.opaque,'preserve');
assert.equal(lastReminder.notificationId,42);
assert.equal(JSON.parse(await run('calendar_reminders')).scope,'app_owned_reminder_agents');
const beforeComplete=writes;
assert.equal(JSON.parse(await run('calendar_reminder_complete',{id:'0'})).status,'unsupported');
assert.equal(writes,beforeComplete);

// Cancellation during the actual permission promise prevents all native reads/writes.
let releasePermission;
permissionWait=new Promise(resolve=>releasePermission=resolve);
const permissionReads=reads, permissionWrites=writes;
const cancelled=run('contacts_update',{key:'contact-key',note:'cancelled'});
current=false;releasePermission();
await assert.rejects(cancelled,/取消/);
assert.equal(reads,permissionReads);assert.equal(writes,permissionWrites);
permissionWait=undefined;current=true;
let releaseRead;
readWait=new Promise(resolve=>releaseRead=resolve);
const stopped=run('contacts_update',{key:'contact-key',note:'cancelled read'});
await new Promise(resolve=>setImmediate(resolve));
current=false;releaseRead();
await assert.rejects(stopped,/取消/);
assert.equal(writes,permissionWrites);
readWait=undefined;current=true;
allowWrite=false;
const beforeDeniedPermissions=permissionCalls;
assert.match(await run('calendar_create',{title:'Test',start:'2026-11-10T10:00:00+08:00',end:'2026-11-10T11:00:00+08:00'}),/__GRANT__/);
assert.equal(permissionCalls,beforeDeniedPermissions);
assert.match(await run('contacts_get',{key:'contact-key'},'owner',true),/前台/);
assert.equal(permissionCalls,beforeDeniedPermissions);
assert.ok(approvals.every(owner=>owner==='owner'));
console.log('PLATFORM_FIELDS_OK actual ETS main entry, contacts/multiple calendars/reminders, partial-field retention, unsupported scope and permission/read cancellation');

// Native camera ownership survives the parent Ability's UI transition, but task cancellation does not.
allowWrite=true;current=true;foreground=true;
let finishCamera;
const removedPhotos=[];
environment.camera={CameraPosition:{CAMERA_POSITION_FRONT:2,CAMERA_POSITION_BACK:1}};
environment.cameraPicker={PickerMediaType:{PHOTO:1},pick:async()=>new Promise(resolve=>finishCamera=resolve)};
environment.fileUri={getUriFromPath:path=>path};
environment.util={generateRandomUUID:()=>"camera-fixture"};
environment.fileIo={OpenMode:{},accessSync:()=>true,openSync:()=>({fd:1}),closeSync(){},statSync:()=>({size:3}),unlinkSync:path=>removedPhotos.push(path)};
for(const key of ['camera','cameraPicker','fileUri','util','fileIo']) context[key]=environment[key];
ui.filesDir='/app/files';
let cameraResult=run('camera_capture',{facing:'front'});
await new Promise(resolve=>setImmediate(resolve));foreground=false;finishCamera({resultCode:0});
assert.equal(JSON.parse(await cameraResult).status,'captured');assert.equal(removedPhotos.length,0);
foreground=true;cameraResult=run('camera_capture',{facing:'front'});
await new Promise(resolve=>setImmediate(resolve));current=false;finishCamera({resultCode:0});
await assert.rejects(cameraResult,/取消/);assert.equal(removedPhotos.length,1);
console.log('PLATFORM_UI_RESULT_OK confirmed camera survives parent foreground timing, cancelled task discards its own file');
