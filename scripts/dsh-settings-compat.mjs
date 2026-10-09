//#region HarmonyOS patch: legacy settings API compat for dsh-settings 0.2.x
// 上游 0.2.x 把 SettingsProvider 重写为 SettingsForms（Config/configEditor 自动分区），
// 删掉了 settingsNamespace / installSettingsSection / settings.register / settings.get，
// 而本机社区插件（market / hiboard / 皮肤 / kb / visual / workstation / scholar…）仍走旧 API。
// 这里在 0.2.x 的 SettingsForms 上补回一套自包含的「旧命名空间存储」，与新的 configEditor
// 表单并存：name 冲突的 describe/update/replace/mutate/write 按 ns 是否属旧命名空间分发。
// 依赖同模块作用域内已有的：join、existsSync、readFileSync、writeFileSync、parse(yaml)、
// isPlainObject、mergeLayers、cloneJsonShaped、applyPathOp、redactSecrets、SettingsConflictError、SettingsForms。
const HX_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
function hxParseNs(value) {
	if (!HX_NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(HX_NAMESPACE_PATTERN)}`);
	return value;
}
function settingsNamespace(value) { return hxParseNs(value); }
function hxDeepFreeze(value) {
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) hxDeepFreeze(value[key]);
		Object.freeze(value);
	}
	return value;
}
function hxDeepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (typeof a !== "object") return false;
	const aArr = Array.isArray(a), bArr = Array.isArray(b);
	if (aArr !== bArr) return false;
	if (aArr) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!hxDeepEqualJson(a[i], b[i])) return false;
		return true;
	}
	const aKeys = Object.keys(a), bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!hxDeepEqualJson(a[key], b[key])) return false;
	}
	return true;
}
const HX_FIBER_DISPOSED = 4;
const HX_FIBER_UNLOADING = 5;
function hxIsUnloading(ctx) {
	const state = ctx?.fiber?.state;
	return state === HX_FIBER_UNLOADING || state === HX_FIBER_DISPOSED;
}
function hxReadDocument(home) {
	if (!home) return {};
	try {
		const jsonPath = join(home, "settings-legacy.json");
		if (existsSync(jsonPath)) return JSON.parse(readFileSync(jsonPath, "utf8")) || {};
	} catch {}
	for (const name of ["settings.yaml", "settings.yaml.imported"]) {
		try {
			const p = join(home, name);
			if (!existsSync(p)) continue;
			const doc = typeof parse === "function" ? parse(readFileSync(p, "utf8")) : undefined;
			if (doc && typeof doc === "object") return doc;
		} catch {}
	}
	return {};
}
function hxWriteDocument(home, doc) {
	if (!home) return;
	try { writeFileSync(join(home, "settings-legacy.json"), JSON.stringify(doc, null, 2) + "\n"); } catch {}
}
/** 旧 SettingsProvider 的最小自包含复刻：一个 JSON 文档 + 命名空间注册表。 */
class HarmonyLegacySettings {
	constructor(ctx, home) {
		this.ctx = ctx;
		this.home = home;
		this.registrations = new Map();
		this.document = hxReadDocument(home);
		this.writeQueues = new Map();
		this.tails = new Set();
		this.stopped = false;
	}
	isStopped() { return this.stopped; }
	get writable() { return true; }
	get documentPath() { return this.home ? join(this.home, "settings-legacy.json") : undefined; }
	prepareDocument() { return Promise.resolve(this.documentPath); }
	has(ns) { try { return this.registrations.has(hxParseNs(ns)); } catch { return false; } }
	section(ns) {
		const section = this.document[ns];
		if (section === undefined) return undefined;
		if (!isPlainObject(section)) throw new TypeError(`settings section "${ns}" must be an object of keys`);
		return section;
	}
	resolve(schema, base, section, validate) {
		const value = schema(mergeLayers(base, section));
		validate?.(value);
		return value;
	}
	register(ns, schema, options) {
		const parsedNs = hxParseNs(ns);
		if (this.registrations.has(parsedNs)) throw new Error(`settings namespace "${parsedNs}" is already registered`);
		const registration = {
			ns: parsedNs,
			schema,
			base: options?.base,
			applies: options?.applies ?? "live",
			...(options?.validate === void 0 ? {} : { validate: options.validate }),
			resolved: hxDeepFreeze(this.resolve(schema, options?.base, this.section(parsedNs), options?.validate)),
			revision: 0,
			watchers: new Set()
		};
		this.ctx.effect(() => {
			this.registrations.set(parsedNs, registration);
			return () => this.registrations.delete(parsedNs);
		}, `settings.register(${JSON.stringify(String(parsedNs))})`);
		return {
			get: () => registration.resolved,
			watch: (callback) => {
				const watcher = { callback, tail: Promise.resolve(), active: true };
				registration.watchers.add(watcher);
				return () => { watcher.active = false; registration.watchers.delete(watcher); };
			},
			update: (patch) => this.update(parsedNs, patch),
			replace: (section) => this.replace(parsedNs, section)
		};
	}
	installSection(owner, ns, schema, entry, hooks) {
		const scope = this.register(ns, schema, {
			base: entry,
			...(hooks.validate === void 0 ? {} : { validate: hooks.validate })
		});
		hooks.setSource(() => scope.get());
		this.ctx.effect(() => () => {
			if (hxIsUnloading(owner)) return;
			hooks.setSource(() => entry);
			hooks.onChange();
		});
		hooks.onChange();
		scope.watch(() => {
			if (hxIsUnloading(owner)) return;
			hooks.onChange();
		});
	}
	describe(options) {
		return [...this.registrations.values()].map((registration) => {
			let user;
			try { user = this.section(registration.ns); } catch { user = void 0; }
			const base = registration.base === void 0 ? void 0 : structuredClone(registration.base);
			const detachedUser = user === void 0 ? void 0 : structuredClone(user);
			const descriptor = {
				ns: registration.ns,
				schema: registration.schema.toJSON(),
				value: registration.resolved,
				revision: registration.revision,
				...(base === void 0 ? {} : { base }),
				...(detachedUser === void 0 ? {} : { user: detachedUser }),
				applies: registration.applies
			};
			if (options?.redactSecrets !== true || typeof redactSecrets !== "function") return descriptor;
			const redacted = redactSecrets(registration.schema, registration.resolved);
			return {
				...descriptor,
				value: redacted.value,
				...(base === void 0 ? {} : { base: redactSecrets(registration.schema, base).value }),
				...(detachedUser === void 0 ? {} : { user: redactSecrets(registration.schema, detachedUser).value }),
				secrets: redacted.secrets
			};
		});
	}
	get(ns) { return this.registrations.get(hxParseNs(ns))?.resolved; }
	async update(ns, patch, expectedRevision) { return this.write(hxParseNs(ns), patch, "merge", expectedRevision); }
	async replace(ns, section, expectedRevision) { return this.write(hxParseNs(ns), section, "replace", expectedRevision); }
	async mutate(ns, ops, expectedRevision) {
		const parsedNs = hxParseNs(ns);
		if (!Array.isArray(ops)) throw new TypeError(`settings mutate for "${parsedNs}" must be an array of path ops`);
		return this.write(parsedNs, ops, "mutate", expectedRevision);
	}
	write(ns, input, mode, expectedRevision) {
		const verb = mode === "merge" ? "update" : mode === "replace" ? "replace" : "mutate";
		const registration = this.registrations.get(ns);
		if (registration === void 0) throw new Error(`settings namespace "${ns}" is not registered`);
		if (this.isStopped()) throw new Error(`settings service is disposed: "${ns}" cannot be written`);
		let payload;
		if (mode === "mutate") payload = { ops: input };
		else {
			if (!isPlainObject(input)) throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`);
			payload = input;
		}
		const snapshot = cloneJsonShaped(payload, (label, path) => new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`));
		const run = (this.writeQueues.get(ns) ?? Promise.resolve()).catch(() => void 0).then(async () => {
			if (this.isStopped()) throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`);
			if (this.registrations.get(ns) !== registration) throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`);
			const current = this.section(ns) ?? {};
			if (expectedRevision !== void 0 && expectedRevision !== registration.revision) throw new SettingsConflictError(ns, expectedRevision, registration.revision);
			const section = mode === "merge" ? mergeLayers(current, snapshot) : mode === "replace" ? snapshot : snapshot["ops"].reduce(applyPathOp, current);
			const next = hxDeepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate));
			this.document[ns] = section;
			hxWriteDocument(this.home, this.document);
			if (this.registrations.get(ns) === registration && !this.isStopped()) {
				if (!hxDeepEqualJson(current, section)) {
					registration.revision += 1;
					this.emitDocumentUpdated(registration.ns, registration.revision);
				}
				this.commit(registration, next, "update");
			}
		});
		this.writeQueues.set(ns, run);
		return run;
	}
	emitDocumentUpdated(ns, revision) {
		try { this.ctx.events?.dispatch?.("emit", ["settings/document-updated", ns, revision]); } catch {}
	}
	commit(registration, next, source) {
		const prev = registration.resolved;
		if (hxDeepEqualJson(next, prev)) return;
		registration.resolved = next;
		for (const watcher of [...registration.watchers]) {
			const segment = watcher.tail.then(() => {
				if (!watcher.active || this.isStopped()) return;
				return watcher.callback(next, prev);
			}).then(() => void 0, () => void 0);
			watcher.tail = segment;
			this.tails.add(segment);
			segment.then(() => this.tails.delete(segment));
		}
		try { this.ctx.events?.dispatch?.("emit", ["settings/updated", registration.ns, next, prev, source]); } catch {}
	}
}
const HX_LEGACY_STORES = new WeakMap();
function hxLegacyStore(service) {
	let store = HX_LEGACY_STORES.get(service);
	if (store === void 0) {
		const home = service.ownerContext?.profileContext?.home;
		store = new HarmonyLegacySettings(service.ctx, home);
		HX_LEGACY_STORES.set(service, store);
	}
	return store;
}
function installSettingsSection(owner, ns, schema, entry, hooks) {
	owner.inject(["settings"], (sctx) => {
		hxLegacyStore(sctx.settings).installSection(owner, ns, schema, entry, hooks);
	});
}
// 把旧命名空间 API 混入 SettingsForms：新方法名冲突者按 ns 分发。
const HX_PROTO = SettingsForms.prototype;
const HX_NEW_DESCRIBE = HX_PROTO.describe;
const HX_NEW_UPDATE = HX_PROTO.update;
const HX_NEW_REPLACE = HX_PROTO.replace;
const HX_NEW_MUTATE = HX_PROTO.mutate;
const HX_NEW_WRITE = HX_PROTO.write;
HX_PROTO.register = function (ns, schema, options) { return hxLegacyStore(this).register(ns, schema, options); };
HX_PROTO.get = function (ns) { return hxLegacyStore(this).get(ns); };
HX_PROTO.section = function (ns) { return hxLegacyStore(this).section(ns); };
HX_PROTO.installSection = function (owner, ns, schema, entry, hooks) { return hxLegacyStore(this).installSection(owner, ns, schema, entry, hooks); };
HX_PROTO.describe = function (options) {
	const legacy = hxLegacyStore(this).describe(options);
	let modern = [];
	try { modern = HX_NEW_DESCRIBE.call(this, options); } catch { modern = []; }
	return [...modern, ...legacy];
};
HX_PROTO.update = function (ns, patch, expectedRevision) {
	const store = hxLegacyStore(this);
	if (store.has(ns)) return store.update(ns, patch, expectedRevision);
	return HX_NEW_UPDATE.call(this, ns, patch, expectedRevision);
};
HX_PROTO.replace = function (ns, section, expectedRevision) {
	const store = hxLegacyStore(this);
	if (store.has(ns)) return store.replace(ns, section, expectedRevision);
	return HX_NEW_REPLACE.call(this, ns, section, expectedRevision);
};
HX_PROTO.mutate = function (ns, ops, expectedRevision) {
	const store = hxLegacyStore(this);
	if (store.has(ns)) return store.mutate(ns, ops, expectedRevision);
	return HX_NEW_MUTATE.call(this, ns, ops, expectedRevision);
};
HX_PROTO.write = function (ns, ...rest) {
	const store = hxLegacyStore(this);
	if (store.has(ns)) return store.write(ns, ...rest);
	return HX_NEW_WRITE.call(this, ns, ...rest);
};
//#endregion
