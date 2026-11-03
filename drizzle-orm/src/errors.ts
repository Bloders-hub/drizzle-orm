import { entityKind } from './entity.ts';

export class DrizzleError extends Error {
	static readonly [entityKind]: string = 'DrizzleError';

	constructor({ message, cause }: { message?: string; cause?: unknown }) {
		super(message);
		this.name = 'DrizzleError';
		this.cause = cause;
	}
}

export class DrizzleQueryError extends DrizzleError {
	static override readonly [entityKind]: string = 'DrizzleQueryError';

	constructor(
		public query: string,
		public params: any[],
		cause?: unknown,
	) {
		super({ message: `Failed query: ${query}\nparams: ${params}`, cause });
		this.name = 'DrizzleQueryError';
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, DrizzleQueryError);
		}
	}

	static from(query: string, params: any[] = [], cause?: unknown): DrizzleQueryError {
		return wrapQueryError(cause, query, params);
	}
}

export class TransactionRollbackError extends DrizzleError {
	static override readonly [entityKind]: string = 'TransactionRollbackError';

	constructor() {
		super({ message: 'Rollback' });
	}
}

export interface ConstraintErrorParams {
	message?: string;
	constraint?: string;
	table?: string;
	column?: string;
	detail?: string;
	cause?: unknown;
	query?: string;
	params?: any[];
}

export class DrizzleConstraintError extends DrizzleQueryError {
	static override readonly [entityKind]: string = 'DrizzleConstraintError';

	readonly constraint?: string;
	readonly table?: string;
	readonly column?: string;
	readonly detail?: string;

	constructor({
		message,
		constraint,
		table,
		column,
		detail,
		cause,
		query = '',
		params = [],
	}: ConstraintErrorParams) {
		super(query, params, cause);
		this.name = 'DrizzleConstraintError';
		this.constraint = constraint;
		this.table = table;
		this.column = column;
		this.detail = detail;

		if (message) {
			this.message = message;
		}
	}
}

export class UniqueConstraintError extends DrizzleConstraintError {
	static override readonly [entityKind]: string = 'UniqueConstraintError';

	constructor(params: ConstraintErrorParams = {}) {
		super({
			...params,
			message: params.message ?? `Unique constraint violation${params.constraint ? `: ${params.constraint}` : ''}`,
		});
		this.name = 'UniqueConstraintError';
	}
}

export class ForeignKeyConstraintError extends DrizzleConstraintError {
	static override readonly [entityKind]: string = 'ForeignKeyConstraintError';

	constructor(params: ConstraintErrorParams = {}) {
		super({
			...params,
			message: params.message ?? `Foreign key constraint violation${params.constraint ? `: ${params.constraint}` : ''}`,
		});
		this.name = 'ForeignKeyConstraintError';
	}
}

export class NotNullConstraintError extends DrizzleConstraintError {
	static override readonly [entityKind]: string = 'NotNullConstraintError';

	constructor(params: ConstraintErrorParams = {}) {
		super({
			...params,
			message: params.message ?? `Not-null constraint violation${params.column ? ` on column '${params.column}'` : ''}`,
		});
		this.name = 'NotNullConstraintError';
	}
}

export class CheckConstraintError extends DrizzleConstraintError {
	static override readonly [entityKind]: string = 'CheckConstraintError';

	constructor(params: ConstraintErrorParams = {}) {
		super({
			...params,
			message: params.message ?? `Check constraint violation${params.constraint ? `: ${params.constraint}` : ''}`,
		});
		this.name = 'CheckConstraintError';
	}
}

export interface ExtractedConstraintInfo {
	type: 'unique' | 'foreign_key' | 'not_null' | 'check';
	constraint?: string;
	table?: string;
	column?: string;
	detail?: string;
}

export function extractConstraintInfo(error: unknown): ExtractedConstraintInfo | undefined {
	if (!error || typeof error !== 'object') {
		return undefined;
	}

	const err = error as Record<string, any>;
	const code = String(err.code || err.errno || '').toUpperCase();
	const msg = String(err.message || '');
	const detail = typeof err.detail === 'string' ? err.detail : undefined;
	const table = typeof err.table === 'string' ? err.table : undefined;
	const column = typeof err.column === 'string' ? err.column : undefined;
	const constraint = typeof err.constraint === 'string' ? err.constraint : undefined;

	// 1. PostgreSQL codes (standard SQLSTATE class 23)
	if (code === '23505' || code === 'UNIQUE_VIOLATION') {
		let extractedColumn = column;
		if (!extractedColumn && detail) {
			const m = detail.match(/Key \((.*?)\)=/);
			if (m) extractedColumn = m[1];
		}
		return {
			type: 'unique',
			constraint,
			table,
			column: extractedColumn,
			detail,
		};
	}

	if (code === '23503' || code === 'FOREIGN_KEY_VIOLATION') {
		return {
			type: 'foreign_key',
			constraint,
			table,
			column,
			detail,
		};
	}

	if (code === '23502' || code === 'NOT_NULL_VIOLATION') {
		return {
			type: 'not_null',
			constraint,
			table,
			column,
			detail,
		};
	}

	if (code === '23514' || code === 'CHECK_VIOLATION') {
		return {
			type: 'check',
			constraint,
			table,
			column,
			detail,
		};
	}

	// 2. MySQL codes / error names
	if (code === '1062' || code === 'ER_DUP_ENTRY') {
		let extractedTable = table;
		let extractedConstraint = constraint;
		const keyMatch = msg.match(/for key '(?:([^.]+)\.)?([^']+)'/);
		if (keyMatch) {
			if (keyMatch[1]) extractedTable = keyMatch[1];
			extractedConstraint = keyMatch[2];
		}
		return {
			type: 'unique',
			constraint: extractedConstraint,
			table: extractedTable,
			column,
			detail: msg,
		};
	}

	if (
		code === '1451'
		|| code === '1452'
		|| code === 'ER_ROW_IS_REFERENCED'
		|| code === 'ER_ROW_IS_REFERENCED_2'
		|| code === 'ER_NO_REFERENCED_ROW'
		|| code === 'ER_NO_REFERENCED_ROW_2'
	) {
		let extractedConstraint = constraint;
		const fkMatch = msg.match(/CONSTRAINT `([^`]+)`/);
		if (fkMatch) {
			extractedConstraint = fkMatch[1];
		}
		return {
			type: 'foreign_key',
			constraint: extractedConstraint,
			table,
			column,
			detail: msg,
		};
	}

	if (code === '1048' || code === 'ER_BAD_NULL_ERROR') {
		let extractedColumn = column;
		const colMatch = msg.match(/Column '([^']+)' cannot be null/);
		if (colMatch) {
			extractedColumn = colMatch[1];
		}
		return {
			type: 'not_null',
			constraint,
			table,
			column: extractedColumn,
			detail: msg,
		};
	}

	if (code === '3819' || code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
		let extractedConstraint = constraint;
		const chkMatch = msg.match(/Check constraint '([^']+)' is violated/);
		if (chkMatch) {
			extractedConstraint = chkMatch[1];
		}
		return {
			type: 'check',
			constraint: extractedConstraint,
			table,
			column,
			detail: msg,
		};
	}

	// 3. SQLite error codes and messages
	if (
		code.includes('SQLITE_CONSTRAINT_UNIQUE')
		|| code.includes('SQLITE_CONSTRAINT_PRIMARYKEY')
		|| msg.includes('UNIQUE constraint failed')
	) {
		let extractedTable = table;
		let extractedColumn = column;
		const m = msg.match(/UNIQUE constraint failed: ([^.\s]+)\.([^\s,]+)/);
		if (m) {
			extractedTable = m[1];
			extractedColumn = m[2];
		}
		return {
			type: 'unique',
			constraint: constraint ?? (extractedColumn ? `${extractedTable ?? ''}_${extractedColumn}_unique` : undefined),
			table: extractedTable,
			column: extractedColumn,
			detail: msg,
		};
	}

	if (code.includes('SQLITE_CONSTRAINT_FOREIGNKEY') || msg.includes('FOREIGN KEY constraint failed')) {
		return {
			type: 'foreign_key',
			constraint,
			table,
			column,
			detail: msg,
		};
	}

	if (code.includes('SQLITE_CONSTRAINT_NOTNULL') || msg.includes('NOT NULL constraint failed')) {
		let extractedTable = table;
		let extractedColumn = column;
		const m = msg.match(/NOT NULL constraint failed: ([^.\s]+)\.([^\s,]+)/);
		if (m) {
			extractedTable = m[1];
			extractedColumn = m[2];
		}
		return {
			type: 'not_null',
			constraint,
			table: extractedTable,
			column: extractedColumn,
			detail: msg,
		};
	}

	if (code.includes('SQLITE_CONSTRAINT_CHECK') || msg.includes('CHECK constraint failed')) {
		return {
			type: 'check',
			constraint,
			table,
			column,
			detail: msg,
		};
	}

	return undefined;
}

export function wrapQueryError(
	cause: unknown,
	query: string,
	params: any[] = [],
): DrizzleQueryError {
	const info = extractConstraintInfo(cause);
	if (info) {
		const baseParams: ConstraintErrorParams = {
			cause,
			query,
			params,
			constraint: info.constraint,
			table: info.table,
			column: info.column,
			detail: info.detail,
		};

		switch (info.type) {
			case 'unique':
				return new UniqueConstraintError(baseParams);
			case 'foreign_key':
				return new ForeignKeyConstraintError(baseParams);
			case 'not_null':
				return new NotNullConstraintError(baseParams);
			case 'check':
				return new CheckConstraintError(baseParams);
		}
	}

	return new DrizzleQueryError(query, params, cause);
}

// --- Type Guards ---

export function isDrizzleError(error: unknown): error is DrizzleError {
	return error instanceof DrizzleError || (typeof error === 'object' && error !== null && (error as any)[entityKind] === 'DrizzleError');
}

export function isDrizzleQueryError(error: unknown): error is DrizzleQueryError {
	return error instanceof DrizzleQueryError || (typeof error === 'object' && error !== null && (error as any)[entityKind] === 'DrizzleQueryError');
}

export function isConstraintError(error: unknown): error is DrizzleConstraintError {
	return error instanceof DrizzleConstraintError;
}

export function isUniqueConstraintError(error: unknown): error is UniqueConstraintError {
	return error instanceof UniqueConstraintError;
}

export function isForeignKeyConstraintError(error: unknown): error is ForeignKeyConstraintError {
	return error instanceof ForeignKeyConstraintError;
}

export function isNotNullConstraintError(error: unknown): error is NotNullConstraintError {
	return error instanceof NotNullConstraintError;
}

export function isCheckConstraintError(error: unknown): error is CheckConstraintError {
	return error instanceof CheckConstraintError;
}
