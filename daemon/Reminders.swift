// reminders-daemon: a long-lived Swift process that talks EventKit and speaks
// newline-delimited JSON over stdio. Replaces per-call osascript spawning.
//
// Protocol:
//   Request:  {"id": <int>, "op": <string>, "args": {...}}\n
//   Response: {"id": <int>, "ok": true,  "result": ...}\n
//             {"id": <int>, "ok": false, "error": "..."}\n
//   Push:     {"event": "ready"}\n
//             {"event": "changed"}\n     (on any EKEventStore change incl. iCloud)
//             {"event": "fatal", "error": "..."}\n  (then exits)

import CoreLocation
import EventKit
import Foundation

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError

func emit(_ object: [String: Any]) {
    // Write the JSON payload and trailing newline as a single contiguous Data
    // so a partial write can never split the line. All emits run on the main
    // thread, but this still reduces the chance of interleaving if that ever
    // changes.
    do {
        var data = try JSONSerialization.data(withJSONObject: object, options: [])
        data.append(0x0A)
        stdoutHandle.write(data)
    } catch {
        let fallback: [String: Any] = ["ok": false, "error": "json encode failed: \(error.localizedDescription)"]
        if var d = try? JSONSerialization.data(withJSONObject: fallback) {
            d.append(0x0A)
            stdoutHandle.write(d)
        }
    }
}

func log(_ msg: String) {
    let line = "[reminders-daemon] \(msg)\n"
    if let d = line.data(using: .utf8) { stderrHandle.write(d) }
}

// ---------------------------------------------------------------------------
// EventKit setup + permission
// ---------------------------------------------------------------------------

let store = EKEventStore()

// Last time we nudged macOS to re-sync CalDAV/Google calendar sources.
// getEvents nudges at most once a minute — the sync it triggers fires
// EKEventStoreChanged, which makes the frontend call getEvents again, so an
// unthrottled nudge could ping-pong.
var lastSourceRefresh = Date.distantPast

func requestAccess() -> Bool {
    let sema = DispatchSemaphore(value: 0)
    var ok = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToReminders { granted, err in
            ok = granted
            if let e = err { log("access error: \(e.localizedDescription)") }
            sema.signal()
        }
    } else {
        store.requestAccess(to: .reminder) { granted, err in
            ok = granted
            if let e = err { log("access error: \(e.localizedDescription)") }
            sema.signal()
        }
    }
    sema.wait()
    return ok
}

guard requestAccess() else {
    emit(["event": "fatal", "error": "Reminders access denied. Open System Settings → Privacy & Security → Reminders and enable access for Todo App (or for Terminal, if you launched the server from a terminal), then retry."])
    exit(2)
}

// Calendar (events) access is requested LAZILY — only when a calendar op
// arrives — so users who never open the calendar pane never see the TCC
// prompt. Read-only: the daemon has no event-write ops.
// Only a GRANT is cached. A denial must not stick for the daemon's lifetime:
// the user's whole recovery path is "enable it in System Settings, then press
// r", and caching `false` made that fail until the app was relaunched. Asking
// again is cheap — once TCC has a decision on record macOS answers from it
// without re-prompting.
var eventsAccessGranted = false
func ensureEventsAccess() throws {
    if eventsAccessGranted { return }
    let sema = DispatchSemaphore(value: 0)
    var ok = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, err in
            ok = granted
            if let e = err { log("calendar access error: \(e.localizedDescription)") }
            sema.signal()
        }
    } else {
        store.requestAccess(to: .event) { granted, err in
            ok = granted
            if let e = err { log("calendar access error: \(e.localizedDescription)") }
            sema.signal()
        }
    }
    sema.wait()
    eventsAccessGranted = ok
    // Explicit throw, NOT a recursive re-check: with denials no longer cached,
    // recursing here would loop forever.
    if !ok {
        throw DaemonError.userError("Calendar access denied. Open System Settings → Privacy & Security → Calendars and enable access for Todo App, then retry.")
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func priorityIntFromString(_ s: String?) throws -> Int {
    switch s {
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    // nil / "" / "none" explicitly clear the priority (same as every other field).
    case nil, "", "none": return 0
    // Anything else is a caller mistake. Don't silently wipe an existing
    // priority to "none" — throw, like every other unparseable field does.
    default:
        throw DaemonError.userError("Unknown priority \"\(s ?? "")\" — use high, medium, low, or none.")
    }
}

func priorityStringFromInt(_ p: Int) -> String {
    // EventKit semantics (RFC 5545): 1–4 high, 5 medium, 6–9 low, 0 none.
    // Apple's own apps write 1/5/9, but other EventKit clients use the ranges.
    switch p {
    case 1...4: return "high"
    case 5: return "medium"
    case 6...9: return "low"
    default: return "none"
    }
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

// `.withFractionalSeconds` makes the formatter REQUIRE millis on parse, so
// "2026-08-15T09:00:00Z" (what an LLM typically writes) would fail. Always
// parse through this helper, which accepts both forms.
let isoFormatterNoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseISODate(_ s: String) -> Date? {
    isoFormatter.date(from: s) ?? isoFormatterNoFrac.date(from: s)
}

// Due dates arrive as either a full ISO date-time (timed reminder) or a bare
// "YYYY-MM-DD" (all-day reminder → date-only components, no h/m/s, matching
// how Reminders.app stores all-day items). Throws on anything else — the
// no-silent-drop convention.
func dueComponentsFromString(_ s: String) throws -> DateComponents {
    if s.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
        let parts = s.split(separator: "-").compactMap { Int($0) }
        var comps = DateComponents()
        comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]
        guard comps.isValidDate(in: Calendar.current) else {
            throw DaemonError.userError("dueDate is not a valid calendar date: \(s)")
        }
        return comps
    }
    if let date = parseISODate(s) {
        return dateComponentsFromDate(date)
    }
    throw DaemonError.userError("dueDate is not a valid ISO 8601 date: \(s)")
}

func dateFromComponents(_ comps: DateComponents?) -> Date? {
    guard let comps = comps else { return nil }
    return Calendar.current.date(from: comps)
}

// List color as a #rrggbb hex string (sRGB), for sidebar swatches.
func hexFromCGColor(_ c: CGColor) -> String? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let conv = c.converted(to: space, intent: .defaultIntent, options: nil),
          let comps = conv.components, comps.count >= 3 else { return nil }
    let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
    return String(format: "#%02x%02x%02x", r, g, b)
}

func dateComponentsFromDate(_ date: Date) -> DateComponents {
    Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
}

// EKWeekday raw values are 1=Sun … 7=Sat.
let weekdayShortNames: [Int: String] = [1: "sun", 2: "mon", 3: "tue", 4: "wed", 5: "thu", 6: "fri", 7: "sat"]

func ekWeekdayFromName(_ s: String) -> EKWeekday? {
    switch s.prefix(3) {
    case "sun": return .sunday
    case "mon": return .monday
    case "tue": return .tuesday
    case "wed": return .wednesday
    case "thu": return .thursday
    case "fri": return .friday
    case "sat": return .saturday
    default: return nil
    }
}

// Labels are ROUND-TRIPPABLE: every string this can produce (except "custom")
// is accepted back by applyRecurrence. Keep the two in sync.
func recurrenceLabel(_ r: EKReminder) -> String {
    guard let rules = r.recurrenceRules, let rule = rules.first else { return "" }
    let interval = rule.interval
    switch rule.frequency {
    case .daily:
        return interval == 1 ? "daily" : "every \(interval) days"
    case .weekly:
        if let days = rule.daysOfTheWeek, !days.isEmpty, interval == 1 {
            let dayNums = Set(days.map { $0.dayOfTheWeek.rawValue })
            if dayNums == Set([2,3,4,5,6]) { return "weekdays" }   // Mon..Fri
            let names = dayNums.sorted().compactMap { weekdayShortNames[$0] }
            if !names.isEmpty { return "every " + names.joined(separator: " and ") }
        }
        return interval == 1 ? "weekly" : "every \(interval) weeks"
    case .monthly:
        return interval == 1 ? "monthly" : "every \(interval) months"
    case .yearly:
        return interval == 1 ? "yearly" : "every \(interval) years"
    @unknown default:
        return "custom"
    }
}

// Lossless recovery representation; labels are for display, not backups.
func recurrenceSnapshot(_ rule: EKRecurrenceRule) -> [String: Any] {
    var out: [String: Any] = ["frequency": rule.frequency.rawValue, "interval": rule.interval,
        "daysOfWeek": (rule.daysOfTheWeek ?? []).map { ["day": $0.dayOfTheWeek.rawValue, "week": $0.weekNumber] }]
    out["daysOfMonth"] = rule.daysOfTheMonth ?? []
    out["monthsOfYear"] = rule.monthsOfTheYear ?? []
    out["weeksOfYear"] = rule.weeksOfTheYear ?? []
    out["daysOfYear"] = rule.daysOfTheYear ?? []
    out["setPositions"] = rule.setPositions ?? []
    if let end = rule.recurrenceEnd {
        if let date = end.endDate { out["endDate"] = isoFormatter.string(from: date) }
        else { out["occurrenceCount"] = end.occurrenceCount }
    }
    return out
}

func applyRecurrenceSnapshots(_ r: EKReminder, snapshots: [[String: Any]]) throws {
    var rules: [EKRecurrenceRule] = []
    for entry in snapshots {
        guard let raw = entry["frequency"] as? Int, let freq = EKRecurrenceFrequency(rawValue: raw),
              let interval = entry["interval"] as? Int, interval > 0 else {
            throw DaemonError.userError("invalid recurrence snapshot")
        }
        func numbers(_ key: String, _ range: ClosedRange<Int>, excludeZero: Bool = false) throws -> [NSNumber]? {
            guard let raw = entry[key] else { return nil }
            guard let values = raw as? [Int], values.allSatisfy({ range.contains($0) && (!excludeZero || $0 != 0) }) else {
                throw DaemonError.userError("invalid recurrence snapshot field: \(key)")
            }
            return values.isEmpty ? nil : values.map { NSNumber(value: $0) }
        }
        guard let dayEntries = entry["daysOfWeek"] as? [[String: Int]] else {
            throw DaemonError.userError("invalid recurrence weekdays")
        }
        var days: [EKRecurrenceDayOfWeek] = []
        for day in dayEntries {
            guard let number = day["day"], let weekday = EKWeekday(rawValue: number),
                  let week = day["week"], (-53...53).contains(week) else {
                throw DaemonError.userError("invalid recurrence weekday")
            }
            days.append(EKRecurrenceDayOfWeek(weekday, weekNumber: week))
        }
        var end: EKRecurrenceEnd? = nil
        if let rawEnd = entry["endDate"] {
            guard let str = rawEnd as? String, let date = parseISODate(str) else {
                throw DaemonError.userError("invalid recurrence end")
            }
            end = EKRecurrenceEnd(end: date)
        } else if let count = entry["occurrenceCount"] as? Int {
            guard count > 0 else { throw DaemonError.userError("invalid recurrence count") }
            end = EKRecurrenceEnd(occurrenceCount: count)
        }
        rules.append(EKRecurrenceRule(recurrenceWith: freq, interval: interval,
            daysOfTheWeek: days.isEmpty ? nil : days,
            daysOfTheMonth: try numbers("daysOfMonth", -31...31, excludeZero: true),
            monthsOfTheYear: try numbers("monthsOfYear", 1...12),
            weeksOfTheYear: try numbers("weeksOfYear", -53...53, excludeZero: true),
            daysOfTheYear: try numbers("daysOfYear", -366...366, excludeZero: true),
            setPositions: try numbers("setPositions", -366...366, excludeZero: true), end: end))
    }
    for old in r.recurrenceRules ?? [] { r.removeRecurrenceRule(old) }
    for rule in rules { r.addRecurrenceRule(rule) }
}

func alarmsArray(_ r: EKReminder) -> [[String: Any]] {
    guard let alarms = r.alarms else { return [] }
    return alarms.map { a -> [String: Any] in
        // Location alarms first — they have neither absoluteDate nor a
        // meaningful relativeOffset, and used to serialize as a bogus
        // {type:"relative", offset:0} (which then DESTROYED the geofence on
        // any round-trip through applyAlarms).
        if let loc = a.structuredLocation {
            var d: [String: Any] = [
                "type": "location",
                "title": loc.title ?? "",
                "proximity": a.proximity == .enter ? "enter" : a.proximity == .leave ? "leave" : "none",
                "radius": loc.radius,
            ]
            if let geo = loc.geoLocation {
                d["latitude"] = geo.coordinate.latitude
                d["longitude"] = geo.coordinate.longitude
            }
            return d
        }
        if let abs = a.absoluteDate {
            return ["type": "absolute", "date": isoFormatter.string(from: abs)]
        }
        return ["type": "relative", "offset": a.relativeOffset]   // seconds; negative = before due
    }
}

func reminderToDict(_ r: EKReminder) -> [String: Any] {
    var dict: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "body": r.notes ?? "",
        "url": r.url?.absoluteString ?? "",
        "completed": r.isCompleted,
        "priority": priorityStringFromInt(r.priority),
        "listId": r.calendar?.calendarIdentifier ?? "",
        "listName": r.calendar?.title ?? "",
        "recurrence": recurrenceLabel(r),
        "recurrenceRules": (r.recurrenceRules ?? []).map(recurrenceSnapshot),
        "alarms": alarmsArray(r),
    ]
    if let comps = r.dueDateComponents, let due = dateFromComponents(comps) {
        dict["dueDate"] = isoFormatter.string(from: due)
        // Date-only components = an all-day reminder. The ISO above is local
        // midnight, indistinguishable from an explicit 12:00 AM — this flag is
        // how clients tell them apart (and avoid re-writing all-day as timed).
        dict["allDay"] = comps.hour == nil
    } else {
        dict["dueDate"] = NSNull()
        dict["allDay"] = false
    }
    if let comp = r.completionDate {
        dict["completionDate"] = isoFormatter.string(from: comp)
    } else {
        dict["completionDate"] = NSNull()
    }
    if let created = r.creationDate {
        dict["creationDate"] = isoFormatter.string(from: created)
    } else {
        dict["creationDate"] = NSNull()
    }
    return dict
}

func fetchSync(predicate: NSPredicate) throws -> [EKReminder] {
    let sema = DispatchSemaphore(value: 0)
    var result: [EKReminder]? = nil
    store.fetchReminders(matching: predicate) { items in
        result = items
        sema.signal()
    }
    guard sema.wait(timeout: .now() + 15) == .success else {
        throw NSError(
            domain: "TodoRemindersDaemon",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Reminders did not answer within 15 seconds; try again."]
        )
    }
    guard let items = result else { throw DaemonError.userError("Reminders returned an incomplete fetch; retry.") }
    return items
}

enum DaemonError: Error {
    case userError(String)
}

// URL field validation. App deep-links (slack://, notion://, …) are allowed —
// they're legitimately useful — but script-ish schemes are rejected: the web
// frontend renders this field as a clickable link inside a WKWebView, where a
// javascript: URL would execute with full access to the app.
let forbiddenURLSchemes: Set<String> = ["javascript", "data", "vbscript", "file"]

func validatedURL(_ s: String) throws -> URL {
    guard let u = URL(string: s) else {
        throw DaemonError.userError("url is not a valid URL: \(s)")
    }
    if let scheme = u.scheme?.lowercased(), forbiddenURLSchemes.contains(scheme) {
        throw DaemonError.userError("url scheme '\(scheme):' is not allowed in the URL field")
    }
    return u
}

// Apply a recurrence string. Grammar (everything recurrenceLabel can emit,
// plus the parser's normalized forms):
//   "" / "none"                                  clear
//   daily / weekdays / weekly / monthly / yearly  presets
//   "every N days|weeks|months|years"             interval (N ≥ 1)
//   "every mon and thu" / "every sat"             weekly pinned to weekdays
// The new rule is resolved BEFORE existing rules are stripped — an unknown
// string must throw with the old rules intact (no-silent-wipe convention).
func applyRecurrence(_ r: EKReminder, preset: String) throws {
    let p = preset.lowercased().trimmingCharacters(in: .whitespaces)
    var clear = false
    var newRule: EKRecurrenceRule? = nil

    func weeklyOn(_ days: [EKWeekday]) -> EKRecurrenceRule {
        EKRecurrenceRule(
            recurrenceWith: .weekly, interval: 1,
            daysOfTheWeek: days.map { EKRecurrenceDayOfWeek($0) },
            daysOfTheMonth: nil, monthsOfTheYear: nil,
            weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: nil
        )
    }

    if p == "" || p == "none" {
        clear = true
    } else if p == "daily" {
        newRule = EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: nil)
    } else if p == "weekdays" {
        newRule = weeklyOn([.monday, .tuesday, .wednesday, .thursday, .friday])
    } else if p == "weekly" {
        newRule = EKRecurrenceRule(recurrenceWith: .weekly, interval: 1, end: nil)
    } else if p == "monthly" {
        newRule = EKRecurrenceRule(recurrenceWith: .monthly, interval: 1, end: nil)
    } else if p == "yearly" {
        newRule = EKRecurrenceRule(recurrenceWith: .yearly, interval: 1, end: nil)
    } else if p.hasPrefix("every ") {
        let body = String(p.dropFirst("every ".count))
        let parts = body.split(separator: " ").map(String.init)
        // "every N units"
        if parts.count == 2, let n = Int(parts[0]), n >= 1 {
            let unit = parts[1].hasSuffix("s") ? String(parts[1].dropLast()) : parts[1]
            let freq: EKRecurrenceFrequency? =
                unit == "day" ? .daily : unit == "week" ? .weekly :
                unit == "month" ? .monthly : unit == "year" ? .yearly : nil
            if let f = freq {
                newRule = EKRecurrenceRule(recurrenceWith: f, interval: n, end: nil)
            }
        }
        // "every mon and thu" — weekly on the listed days
        if newRule == nil {
            let tokens = body
                .split(whereSeparator: { $0 == " " || $0 == "," })
                .map(String.init)
                .filter { $0 != "and" && $0 != "&" && !$0.isEmpty }
            let days = tokens.compactMap { ekWeekdayFromName($0) }
            if !tokens.isEmpty, days.count == tokens.count {
                newRule = weeklyOn(days)
            }
        }
    }

    guard clear || newRule != nil else {
        throw DaemonError.userError("unknown recurrence: \(preset) (valid: daily, weekdays, weekly, monthly, yearly, none, 'every N days/weeks/months/years', 'every mon and thu')")
    }
    if let existing = r.recurrenceRules {
        for rule in existing { r.removeRecurrenceRule(rule) }
    }
    if let rule = newRule { r.addRecurrenceRule(rule) }
}

// Apply alarms. Strips existing first. Each entry is
// { type: "relative", offset: seconds }, { type: "absolute", date: ISO }
// ("absolute" is also accepted as the date key — the MCP schema uses it), or
// { type: "location", title, latitude?, longitude?, radius?, proximity? }
// (what alarmsArray emits — so read→write round-trips keep geofences).
// Throws on a malformed entry instead of silently skipping it: stripping the
// existing alarms and then dropping the replacement would lose alarms with
// the call still reporting success.
func applyAlarms(_ r: EKReminder, alarms: [[String: Any]]) throws {
    var parsed: [EKAlarm] = []
    for entry in alarms {
        let type = (entry["type"] as? String) ?? ""
        if type == "relative", let offsetSec = entry["offset"] as? Double {
            parsed.append(EKAlarm(relativeOffset: offsetSec))
        } else if type == "absolute" {
            guard let dateStr = (entry["date"] as? String) ?? (entry["absolute"] as? String) else {
                throw DaemonError.userError("absolute alarm needs a 'date' (ISO 8601 date-time)")
            }
            guard let d = parseISODate(dateStr) else {
                throw DaemonError.userError("alarm date is not a valid ISO 8601 date-time: \(dateStr)")
            }
            parsed.append(EKAlarm(absoluteDate: d))
        } else if type == "location" {
            let alarm = EKAlarm()
            let loc = EKStructuredLocation(title: (entry["title"] as? String) ?? "")
            if let lat = entry["latitude"] as? Double, let lng = entry["longitude"] as? Double {
                loc.geoLocation = CLLocation(latitude: lat, longitude: lng)
            }
            if let radius = entry["radius"] as? Double { loc.radius = radius }
            alarm.structuredLocation = loc
            switch (entry["proximity"] as? String) ?? "enter" {
            case "leave": alarm.proximity = .leave
            case "none":  alarm.proximity = .none
            default:      alarm.proximity = .enter
            }
            parsed.append(alarm)
        } else {
            throw DaemonError.userError("alarm entry must be {type:'relative', offset:seconds}, {type:'absolute', date:ISO}, or {type:'location', …} — got type '\(type)'")
        }
    }
    // Only mutate once every entry validated.
    if let existing = r.alarms {
        for a in existing { r.removeAlarm(a) }
    }
    for a in parsed { r.addAlarm(a) }
}

// ---------------------------------------------------------------------------
// op handlers
// ---------------------------------------------------------------------------

func execute(op: String, args: [String: Any]) throws -> Any {
    switch op {

    case "ping":
        return ["pong": true]

    case "listLists":
        let cals = store.calendars(for: .reminder)
        return cals.map { cal -> [String: Any] in
            var d: [String: Any] = ["id": cal.calendarIdentifier, "name": cal.title]
            if let cg = cal.cgColor, let hex = hexFromCGColor(cg) { d["color"] = hex }
            return d
        }

    case "listCounts":
        let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let items = try fetchSync(predicate: pred)
        var counts: [String: Int] = [:]
        for r in items {
            if let id = r.calendar?.calendarIdentifier {
                counts[id, default: 0] += 1
            }
        }
        return counts

    case "getReminders":
        guard let listId = args["listId"] as? String else { throw DaemonError.userError("listId required") }
        let includeCompleted = (args["includeCompleted"] as? Bool) ?? false
        let cals = store.calendars(for: .reminder)
        guard let cal = cals.first(where: { $0.calendarIdentifier == listId }) else {
            throw DaemonError.userError("list not found")
        }
        let pred: NSPredicate
        if includeCompleted {
            pred = store.predicateForReminders(in: [cal])
        } else {
            pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [cal])
        }
        let items = try fetchSync(predicate: pred)
        return items.map(reminderToDict)

    case "getAllReminders":
        let includeCompleted = (args["includeCompleted"] as? Bool) ?? false
        let pred: NSPredicate
        if includeCompleted {
            pred = store.predicateForReminders(in: nil)
        } else {
            pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        }
        let items = try fetchSync(predicate: pred)
        return items.map(reminderToDict)

    case "addReminder":
        guard let listId = args["listId"] as? String else { throw DaemonError.userError("listId required") }
        guard let name = args["name"] as? String, !name.isEmpty else { throw DaemonError.userError("name required") }
        let cals = store.calendars(for: .reminder)
        guard let cal = cals.first(where: { $0.calendarIdentifier == listId }) else {
            throw DaemonError.userError("list not found")
        }
        if !cal.allowsContentModifications {
            throw DaemonError.userError("this list is read-only and cannot accept new reminders (source: \(cal.source?.title ?? "unknown"))")
        }
        let r = EKReminder(eventStore: store)
        r.calendar = cal
        r.title = name
        if let body = args["body"] as? String, !body.isEmpty { r.notes = body }
        if let urlStr = args["url"] as? String, !urlStr.isEmpty {
            r.url = try validatedURL(urlStr)
        }
        if let pri = args["priority"] as? String { r.priority = try priorityIntFromString(pri) }
        if let dueStr = args["dueDate"] as? String, !dueStr.isEmpty {
            r.dueDateComponents = try dueComponentsFromString(dueStr)
        }
        if args.keys.contains("recurrence"), !(args["recurrence"] is NSNull) {
            guard let rec = args["recurrence"] as? String else {
                throw DaemonError.userError("recurrence must be a string preset (daily, weekdays, weekly, monthly, yearly, none)")
            }
            try applyRecurrence(r, preset: rec)
        }
        if args.keys.contains("alarms"), !(args["alarms"] is NSNull) {
            guard let alarms = args["alarms"] as? [[String: Any]] else {
                throw DaemonError.userError("alarms must be an array of {type, offset|date} objects")
            }
            try applyAlarms(r, alarms: alarms)
        }
        if let snapshots = args["recurrenceRules"] {
            guard let rules = snapshots as? [[String: Any]] else {
                throw DaemonError.userError("recurrenceRules must be an array")
            }
            try applyRecurrenceSnapshots(r, snapshots: rules)
        }
        if let completed = args["completed"] as? Bool {
            r.isCompleted = completed
            if completed, let raw = args["completionDate"] as? String {
                guard let date = parseISODate(raw) else { throw DaemonError.userError("invalid completion date") }
                r.completionDate = date
            }
        }
        try store.save(r, commit: true)
        return reminderToDict(r)

    case "updateReminder":
        guard let id = args["id"] as? String else { throw DaemonError.userError("id required") }
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw DaemonError.userError("reminder not found")
        }
        if let cal = r.calendar, !cal.allowsContentModifications {
            throw DaemonError.userError("this reminder is in a read-only list and cannot be modified (source: \(cal.source?.title ?? "unknown"))")
        }
        if let targetListId = args["listId"] as? String, !targetListId.isEmpty,
           targetListId != r.calendar?.calendarIdentifier {
            let cals = store.calendars(for: .reminder)
            guard let newCal = cals.first(where: { $0.calendarIdentifier == targetListId }) else {
                throw DaemonError.userError("target list not found: \(targetListId)")
            }
            if !newCal.allowsContentModifications {
                throw DaemonError.userError("target list is read-only (source: \(newCal.source?.title ?? "unknown"))")
            }
            r.calendar = newCal
        }
        if let name = args["name"] as? String { r.title = name }
        if args.keys.contains("body") {
            if let body = args["body"] as? String {
                r.notes = body.isEmpty ? nil : body
            } else {
                // explicit null → clear (mirrors url/dueDate; the MCP contract
                // documents "pass null to clear notes")
                r.notes = nil
            }
        }
        if args.keys.contains("url") {
            if let urlStr = args["url"] as? String {
                if urlStr.isEmpty {
                    r.url = nil
                } else {
                    r.url = try validatedURL(urlStr)
                }
            } else {
                // explicit null → clear
                r.url = nil
            }
        }
        if let completed = args["completed"] as? Bool { r.isCompleted = completed }
        if let pri = args["priority"] as? String { r.priority = try priorityIntFromString(pri) }
        if args.keys.contains("recurrence") {
            // null clears (house convention). Any other non-string used to be
            // coerced to "" — which CLEARED recurrence by accident. Throw instead.
            if args["recurrence"] is NSNull {
                try applyRecurrence(r, preset: "")
            } else if let rec = args["recurrence"] as? String {
                try applyRecurrence(r, preset: rec)
            } else {
                throw DaemonError.userError("recurrence must be a string preset or null")
            }
        }
        if args.keys.contains("alarms") {
            // null and [] both clear; a malformed container must throw — the
            // old silent skip reported success without changing anything.
            if args["alarms"] is NSNull {
                try applyAlarms(r, alarms: [])
            } else if let alarms = args["alarms"] as? [[String: Any]] {
                try applyAlarms(r, alarms: alarms)
            } else {
                throw DaemonError.userError("alarms must be an array of {type, offset|date} objects or null")
            }
        }
        if args.keys.contains("dueDate") {
            if let dueStr = args["dueDate"] as? String {
                if dueStr.isEmpty {
                    r.dueDateComponents = nil
                } else {
                    r.dueDateComponents = try dueComponentsFromString(dueStr)
                }
            } else {
                // explicit null → clear
                r.dueDateComponents = nil
            }
        }
        if let snapshots = args["recurrenceRules"] {
            guard let rules = snapshots as? [[String: Any]] else {
                throw DaemonError.userError("recurrenceRules must be an array")
            }
            try applyRecurrenceSnapshots(r, snapshots: rules)
        }
        if let completed = args["completed"] as? Bool {
            r.isCompleted = completed
            if completed, let raw = args["completionDate"] as? String {
                guard let date = parseISODate(raw) else { throw DaemonError.userError("invalid completion date") }
                r.completionDate = date
            }
        }
        try store.save(r, commit: true)
        return reminderToDict(r)

    case "getReminder":
        // Single-reminder snapshot by id. Exists so callers can persist a
        // recoverable copy BEFORE asking EventKit to delete anything — the
        // delete itself is irreversible, so the trash write has to come first.
        guard let id = args["id"] as? String else { throw DaemonError.userError("id required") }
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw DaemonError.userError("reminder not found")
        }
        return reminderToDict(r)

    case "deleteReminder":
        guard let id = args["id"] as? String else { throw DaemonError.userError("id required") }
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw DaemonError.userError("reminder not found")
        }
        if let cal = r.calendar, !cal.allowsContentModifications {
            throw DaemonError.userError("this reminder is in a read-only list and cannot be deleted (source: \(cal.source?.title ?? "unknown"))")
        }
        // Snapshot the full reminder BEFORE removing it, so callers can stash it
        // in the recoverable trash (restore re-creates the task from this dict).
        let snapshot = reminderToDict(r)
        try store.remove(r, commit: true)
        return ["ok": true, "deleted": snapshot]

    case "renameList":
        guard let listId = args["listId"] as? String else { throw DaemonError.userError("listId required") }
        guard let name = args["name"] as? String, !name.isEmpty else { throw DaemonError.userError("name required") }
        let cals = store.calendars(for: .reminder)
        guard let cal = cals.first(where: { $0.calendarIdentifier == listId }) else {
            throw DaemonError.userError("list not found")
        }
        if !cal.allowsContentModifications {
            throw DaemonError.userError("this list is read-only and cannot be renamed (source: \(cal.source?.title ?? "unknown"))")
        }
        cal.title = name
        do {
            try store.saveCalendar(cal, commit: true)
        } catch {
            throw DaemonError.userError("EventKit refused to rename: \(error.localizedDescription)")
        }
        return ["id": cal.calendarIdentifier, "name": cal.title]

    case "createList":
        guard let name = args["name"] as? String, !name.isEmpty else { throw DaemonError.userError("name required") }
        let cal = EKCalendar(for: .reminder, eventStore: store)
        cal.title = name
        if let source = store.defaultCalendarForNewReminders()?.source {
            cal.source = source
        } else if let local = store.sources.first(where: { $0.sourceType == .local }) {
            cal.source = local
        } else if let any = store.sources.first {
            cal.source = any
        } else {
            throw DaemonError.userError("no source available to host new list")
        }
        try store.saveCalendar(cal, commit: true)
        return ["id": cal.calendarIdentifier, "name": cal.title]

    case "getEvents":
        // Read-only calendar (EKEvent) window query for the calendar pane.
        // Requests events TCC access lazily on first use.
        guard let startStr = args["start"] as? String, let start = parseISODate(startStr) else {
            throw DaemonError.userError("start (ISO date) required")
        }
        guard let endStr = args["end"] as? String, let end = parseISODate(endStr) else {
            throw DaemonError.userError("end (ISO date) required")
        }
        guard end > start, end.timeIntervalSince(start) <= 31 * 86400 else {
            throw DaemonError.userError("window must be positive and at most 31 days")
        }
        try ensureEventsAccess()
        // Ask macOS to pull remote (Google/CalDAV) sources NOW instead of on
        // Calendar.app's poll interval — a just-created Google event otherwise
        // takes minutes to reach EventKit. When the sync lands, the change
        // notification triggers an SSE refresh and the pane picks it up.
        if Date().timeIntervalSince(lastSourceRefresh) > 60 {
            lastSourceRefresh = Date()
            store.refreshSourcesIfNecessary()
        }
        let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let all = store.events(matching: pred).sorted { $0.startDate < $1.startDate }
        // Dedupe: the same event often exists in several synced calendars
        // (invitation copies, an account added twice, iCloud + Google mirrors).
        // Calendar.app hides these; match it by collapsing identical
        // (title, start, end, allDay) tuples and keeping the first.
        var seen = Set<String>()
        let events = all.filter { ev in
            let key = "\(ev.title ?? "")|\(ev.startDate?.timeIntervalSince1970 ?? 0)|\(ev.endDate?.timeIntervalSince1970 ?? 0)|\(ev.isAllDay)"
            return seen.insert(key).inserted
        }
        return events.map { ev -> [String: Any] in
            var d: [String: Any] = [
                "id": ev.eventIdentifier ?? "",
                "title": ev.title ?? "",
                "allDay": ev.isAllDay,
            ]
            if let s = ev.startDate { d["start"] = isoFormatter.string(from: s) }
            if let e = ev.endDate   { d["end"]   = isoFormatter.string(from: e) }
            if let cal = ev.calendar {
                d["calendar"] = cal.title
                if let cg = cal.cgColor, let hex = hexFromCGColor(cg) { d["color"] = hex }
            }
            if let loc = ev.location, !loc.isEmpty { d["location"] = loc }
            return d
        }

    case "deleteList":
        guard let listId = args["listId"] as? String else { throw DaemonError.userError("listId required") }
        let cals = store.calendars(for: .reminder)
        guard let cal = cals.first(where: { $0.calendarIdentifier == listId }) else {
            throw DaemonError.userError("list not found")
        }
        if !cal.allowsContentModifications {
            throw DaemonError.userError("this list is read-only and cannot be deleted (source: \(cal.source?.title ?? "unknown"))")
        }
        // Snapshot every reminder (open AND completed) BEFORE the calendar goes,
        // so the caller can stash them in the recoverable trash — deleting the
        // calendar deletes its reminders with it, with no undelete in EventKit.
        let pred = store.predicateForReminders(in: [cal])
        let items = try fetchSync(predicate: pred)
        let snapshots = items.map(reminderToDict)
        let name = cal.title
        do {
            try store.removeCalendar(cal, commit: true)
        } catch {
            throw DaemonError.userError("EventKit refused to delete the list: \(error.localizedDescription)")
        }
        return ["ok": true, "name": name, "deleted": snapshots]

    default:
        throw DaemonError.userError("unknown op: \(op)")
    }
}

// ---------------------------------------------------------------------------
// request dispatch
// ---------------------------------------------------------------------------

func handleRequest(_ req: [String: Any]) {
    let id = req["id"]
    let op = req["op"] as? String ?? ""
    let args = req["args"] as? [String: Any] ?? [:]
    var resp: [String: Any] = [:]
    if let id = id { resp["id"] = id }
    do {
        if let deadline = req["deadline"] as? Double, Date().timeIntervalSince1970 * 1000 >= deadline {
            throw DaemonError.userError("Request expired before execution; no changes made.")
        }
        let result = try execute(op: op, args: args)
        resp["ok"] = true
        resp["result"] = result
    } catch DaemonError.userError(let msg) {
        // Discard any half-applied mutation. updateReminder edits the live
        // EKReminder field-by-field; if a later field throws, the dirty object
        // would otherwise linger in the store's cache and get committed by the
        // NEXT successful save of that reminder.
        store.reset()
        resp["ok"] = false
        resp["error"] = msg
        // Lets the HTTP layer answer 400 (caller mistake) instead of 500.
        resp["userError"] = true
    } catch {
        store.reset()
        resp["ok"] = false
        resp["error"] = error.localizedDescription
    }
    emit(resp)
}

// ---------------------------------------------------------------------------
// change notification → push
// ---------------------------------------------------------------------------

NotificationCenter.default.addObserver(
    forName: .EKEventStoreChanged,
    object: store,
    queue: OperationQueue.main
) { _ in
    emit(["event": "changed"])
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

emit(["event": "ready"])

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8) else {
            DispatchQueue.main.async {
                emit(["ok": false, "error": "non-utf8 input"])
            }
            continue
        }
        do {
            let parsed = try JSONSerialization.jsonObject(with: data, options: [])
            guard let req = parsed as? [String: Any] else {
                DispatchQueue.main.async {
                    emit(["ok": false, "error": "request must be a JSON object"])
                }
                continue
            }
            DispatchQueue.main.async {
                handleRequest(req)
            }
        } catch {
            DispatchQueue.main.async {
                emit(["ok": false, "error": "invalid JSON: \(error.localizedDescription)"])
            }
        }
    }
    // stdin closed → exit cleanly
    exit(0)
}

RunLoop.main.run()
