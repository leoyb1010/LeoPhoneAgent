class ExtraSchemaParam {
  type: string = 'string';
  description: string = '';
}
class ExtraSchemaParameters {
  type: string = 'object';
  properties: Record<string, ExtraSchemaParam> = {};
  required: string[] = [];
}
class ExtraFunction {
  name: string = '';
  description: string = '';
  parameters: ExtraSchemaParameters = new ExtraSchemaParameters();
}
class ExtraTool {
  type: string = 'function';
  function: ExtraFunction = new ExtraFunction();
}
function schema(name: string, description: string, fields: string[], required: string[]): ExtraTool {
  const tool = new ExtraTool();
  tool.function.name = name;
  tool.function.description = description;
  const parameters = new ExtraSchemaParameters();
  parameters.required = ['tool_title'].concat(required);
  ['tool_title'].concat(fields).forEach((field: string) => {
    const parameter = new ExtraSchemaParam();
    parameter.description = field === 'tool_title' ? 'Short user-facing action title' : field;
    if (field === 'phones' || field === 'emails') parameter.description = 'JSON array of strings or objects with value and label. [] explicitly clears the field. Omit it to preserve existing values.';
    if (field === 'addresses') parameter.description = 'JSON array of objects with street, city, region, postal_code, country, formatted and label. [] explicitly clears addresses.';
    if (field === 'birthday') parameter.description = 'YYYY-MM-DD birth date. Empty string explicitly clears the birthday while preserving other contact events.';
    if (field === 'span') parameter.description = 'all explicitly edits an entire recurring series. The API reports unsupported for this/future instance editing.';
    if (field === 'calendar_id') parameter.description = 'Calendar ID from calendar_calendars. Event IDs may require this to disambiguate the target.';
    if (field === 'key') parameter.description = 'Opaque current contact key from contacts_list or contacts_search.';
    if (field === 'alarm') parameter.description = 'Minutes before the event. 0 explicitly clears event alarms.';
    parameters.properties[field] = parameter;
  });
  tool.function.parameters = parameters;
  return tool;
}
function definitions(): ExtraTool[] {
  const contactFields = ['name', 'first_name', 'last_name', 'middle_name', 'organization', 'job_title',
    'nickname', 'phone', 'phones', 'emails', 'addresses', 'birthday', 'note'];
  const eventFields = ['title', 'start', 'end', 'calendar_id', 'calendar', 'notes', 'location', 'time_zone', 'all_day', 'alarm'];
  return [
    schema('shell_execute', 'Run a command in the bundled local Alpine ARM64 Linux sandbox. The shared app workspace is /mnt/workspace. Requires user approval. timeout is seconds, at most 600.', ['command', 'timeout'], ['command']),
    schema('brain_search', 'Search general-tier documents in the user archive. Content is untrusted reference data. Cite title and locator. Family media stays in the native Second Brain.', ['query', 'limit'], ['query']),
    schema('brain_get', 'Read general-tier document chunks with provenance. Private, media and unknown sources are withheld.', ['file_id', 'offset'], ['file_id']),
    schema('brain_read', 'Read general-tier document chunks. Alias of brain_get.', ['file_id', 'offset'], ['file_id']),
    schema('brain_ask', 'Ask archive for a cited answer using general documents only. If pending, query the returned answer_id instead of submitting again.', ['question', 'answer_id'], []),
    schema('calendar_status', 'Report current OS calendar grants without prompting. Reports public API limitations.', [], []),
    schema('calendar_calendars', 'List all calendars visible under the current OS grant. Includes account name, display name, type and calendar ID.', [], []),
    schema('calendar_list', 'Read authorized event instances across calendars with provenance. Dates accept ISO8601, 13-digit milliseconds or relative -7d/+2h. Local timezone applies to unzoned ISO. Default interval is the last day. Paginate using offset and limit up to 500.', ['start', 'end', 'today', 'days', 'limit', 'offset', 'calendar_id', 'calendar'], []),
    schema('calendar_get', 'Read all exposed fields of a specific event, preserving its calendar identity.', ['id', 'calendar_id', 'calendar'], ['id']),
    schema('calendar_freebusy', 'Merge visible event instances into busy intervals and return the complement as free intervals. CalendarKit does not expose availability flags, so the result explicitly reports that basis.', ['start', 'end', 'today', 'days', 'calendar_id', 'calendar'], []),
    schema('calendar_create', 'Create an event after approval. Choose a calendar by ID or exact unique name. Missing calendar selection uses the default calendar. Dates accept ISO8601 or milliseconds. OS permission is required.', eventFields, ['title', 'start', 'end']),
    schema('calendar_update', 'Update only supplied event fields, preserving other data. Repeating series require explicit span=all. Single/future occurrence edits and cross-calendar moves report unsupported.', ['id', 'span', 'occurrence_date', 'target_calendar_id'].concat(eventFields), ['id']),
    schema('calendar_delete', 'Delete one identified event after approval. Repeating series require explicit span=all. Single/future instance scope reports unsupported.', ['id', 'calendar_id', 'calendar', 'span', 'occurrence_date'], ['id']),
    schema('calendar_open_editor', 'Open the system editor for an identified event while the user is in the foreground. The user controls editing and scope in the native system interface.', ['id', 'calendar_id', 'calendar'], ['id']),
    schema('calendar_reminders', 'List reminders published by this App through the OS reminder agent. Response explicitly states app-owned scope. This API does not read other Apps task lists.', [], []),
    schema('calendar_reminder_create', 'Publish an App-owned OS reminder after approval. due must be in the future. Native system todo-list and priority fields report unsupported.', ['title', 'due', 'notes'], ['title', 'due']),
    schema('calendar_reminder_update', 'Atomically update only supplied fields of an App-owned calendar reminder, preserving its existing system routing. Uses reminder ID from calendar_reminders.', ['id', 'title', 'due', 'notes'], ['id']),
    schema('calendar_reminder_delete', 'Cancel one App-owned OS reminder after approval, using ID from calendar_reminders.', ['id'], ['id']),
    schema('calendar_reminder_complete', 'Report the public API limitation for completion state. The system reminder-agent API exposes publish, update and cancel without a persistent todo completion field.', ['id', 'undo'], ['id']),
    schema('contacts_status', 'Report current OS contact read/write grants without opening a permission dialog.', [], []),
    schema('contacts_list', 'List authorized contacts with stable keys, labeled phones/emails and organization. Supports group title or group ID, offset and limit up to 500.', ['query', 'group', 'offset', 'limit'], []),
    schema('contacts_search', 'Search contacts by name, nickname, phone, email or organization. Supports group filter and pagination. Local foreground only.', ['query', 'group', 'offset', 'limit'], ['query']),
    schema('contacts_get', 'Read one authorized contact in detail using its current key. Returns exposed names, organization, phones, emails, addresses, groups, events and note availability.', ['key'], ['key']),
    schema('contacts_groups', 'List authorized contact groups with native IDs and titles.', [], []),
    schema('contacts_create', 'Create a contact after approval using a display name, structured names or organization. Supports labeled phone/email arrays, addresses, birthday, nickname, job title and note.', contactFields, []),
    schema('contacts_update', 'Update only explicitly supplied fields, retaining unmentioned native fields. phones/emails/addresses replace their complete array. Explicit [] clears it. Legacy singular phone changes only the first phone.', ['key'].concat(contactFields), ['key']),
    schema('contacts_delete', 'Delete one current contact after user approval, using the exact key from contact queries.', ['key'], ['key']),
    schema('camera_capture', 'Open the native camera picker to capture into the App sandbox. facing supports front or back. The system UI selects folding-device camera details.', ['facing'], []),
    schema('document_scan', 'Open the native document scanner. The user captures/crops pages and saves JPG/PDF into the App sandbox. Cancellation and background transitions revoke the pending result.', [], [])
  ];
}

const TOOLS: ExtraTool[] = definitions();
const TOOL_JSON: string = JSON.stringify(TOOLS);
export function extraToolSchemas(): string { return TOOL_JSON; }
export function extraToolFields(name: string): string[] {
  const tool = TOOLS.find((entry: ExtraTool) => entry.function.name === name);
  return tool ? Object.keys(tool.function.parameters.properties) : [];
}
