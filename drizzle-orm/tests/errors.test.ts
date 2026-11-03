import { describe, expect, it } from 'vitest';
import {
	CheckConstraintError,
	DrizzleConstraintError,
	DrizzleError,
	DrizzleQueryError,
	extractConstraintInfo,
	ForeignKeyConstraintError,
	isCheckConstraintError,
	isConstraintError,
	isDrizzleError,
	isDrizzleQueryError,
	isForeignKeyConstraintError,
	isNotNullConstraintError,
	isUniqueConstraintError,
	NotNullConstraintError,
	TransactionRollbackError,
	UniqueConstraintError,
	wrapQueryError,
} from '../src/errors.ts';

describe('Drizzle Error Handling & Wrapping Hierarchy (#376)', () => {
	describe('Base DrizzleError and DrizzleQueryError', () => {
		it('preserves message, name, and cause on DrizzleError', () => {
			const cause = new Error('Underlying driver timeout');
			const err = new DrizzleError({ message: 'Database connection failed', cause });

			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(DrizzleError);
			expect(err.name).toBe('DrizzleError');
			expect(err.message).toBe('Database connection failed');
			expect(err.cause).toBe(cause);
			expect(isDrizzleError(err)).toBe(true);
		});

		it('preserves query, params, and cause on DrizzleQueryError', () => {
			const cause = new Error('Connection lost');
			const err = new DrizzleQueryError('SELECT * FROM users WHERE id = $1', [42], cause);

			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(DrizzleError);
			expect(err).toBeInstanceOf(DrizzleQueryError);
			expect(err.name).toBe('DrizzleQueryError');
			expect(err.query).toBe('SELECT * FROM users WHERE id = $1');
			expect(err.params).toEqual([42]);
			expect(err.cause).toBe(cause);
			expect(isDrizzleError(err)).toBe(true);
			expect(isDrizzleQueryError(err)).toBe(true);
			expect(isConstraintError(err)).toBe(false);
		});

		it('supports TransactionRollbackError', () => {
			const err = new TransactionRollbackError();
			expect(err).toBeInstanceOf(DrizzleError);
			expect(err.message).toBe('Rollback');
			expect(isDrizzleError(err)).toBe(true);
		});
	});

	describe('PostgreSQL Constraint Extraction', () => {
		it('extracts unique constraint violation (code 23505)', () => {
			const pgError = {
				code: '23505',
				table: 'users',
				constraint: 'users_email_unique',
				detail: 'Key (email)=(admin@example.com) already exists.',
			};

			const err = DrizzleQueryError.from('INSERT INTO users (email) VALUES ($1)', ['admin@example.com'], pgError);

			expect(err).toBeInstanceOf(UniqueConstraintError);
			expect(err).toBeInstanceOf(DrizzleConstraintError);
			expect(err).toBeInstanceOf(DrizzleQueryError);
			expect(err).toBeInstanceOf(DrizzleError);

			expect(isUniqueConstraintError(err)).toBe(true);
			expect(isConstraintError(err)).toBe(true);
			expect(isDrizzleQueryError(err)).toBe(true);

			if (isUniqueConstraintError(err)) {
				expect(err.table).toBe('users');
				expect(err.constraint).toBe('users_email_unique');
				expect(err.column).toBe('email');
				expect(err.detail).toBe('Key (email)=(admin@example.com) already exists.');
				expect(err.query).toBe('INSERT INTO users (email) VALUES ($1)');
				expect(err.params).toEqual(['admin@example.com']);
			}
		});

		it('extracts foreign key violation (code 23503)', () => {
			const pgError = {
				code: '23503',
				table: 'orders',
				constraint: 'orders_user_id_fkey',
				detail: 'Key (user_id)=(999) is not present in table "users".',
			};

			const err = DrizzleQueryError.from('INSERT INTO orders (user_id) VALUES ($1)', [999], pgError);

			expect(err).toBeInstanceOf(ForeignKeyConstraintError);
			expect(isForeignKeyConstraintError(err)).toBe(true);
			expect(isConstraintError(err)).toBe(true);

			if (isForeignKeyConstraintError(err)) {
				expect(err.table).toBe('orders');
				expect(err.constraint).toBe('orders_user_id_fkey');
			}
		});

		it('extracts not-null constraint violation (code 23502)', () => {
			const pgError = {
				code: '23502',
				table: 'users',
				column: 'username',
			};

			const err = DrizzleQueryError.from('INSERT INTO users (username) VALUES (NULL)', [], pgError);

			expect(err).toBeInstanceOf(NotNullConstraintError);
			expect(isNotNullConstraintError(err)).toBe(true);

			if (isNotNullConstraintError(err)) {
				expect(err.table).toBe('users');
				expect(err.column).toBe('username');
			}
		});

		it('extracts check constraint violation (code 23514)', () => {
			const pgError = {
				code: '23514',
				table: 'accounts',
				constraint: 'check_positive_balance',
			};

			const err = DrizzleQueryError.from('UPDATE accounts SET balance = -10', [], pgError);

			expect(err).toBeInstanceOf(CheckConstraintError);
			expect(isCheckConstraintError(err)).toBe(true);

			if (isCheckConstraintError(err)) {
				expect(err.table).toBe('accounts');
				expect(err.constraint).toBe('check_positive_balance');
			}
		});
	});

	describe('MySQL Constraint Extraction', () => {
		it('extracts duplicate key error (ER_DUP_ENTRY / 1062)', () => {
			const mysqlError = {
				code: 'ER_DUP_ENTRY',
				errno: 1062,
				message: "Duplicate entry 'test@example.com' for key 'users.email_unique'",
			};

			const err = wrapQueryError(mysqlError, 'INSERT INTO users ...', ['test@example.com']);

			expect(isUniqueConstraintError(err)).toBe(true);
			if (isUniqueConstraintError(err)) {
				expect(err.table).toBe('users');
				expect(err.constraint).toBe('email_unique');
			}
		});

		it('extracts foreign key error (errno 1452)', () => {
			const mysqlError = {
				code: 'ER_NO_REFERENCED_ROW_2',
				errno: 1452,
				message: "Cannot add or update a child row: a foreign key constraint fails (`db`.`orders`, CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`))",
			};

			const err = wrapQueryError(mysqlError, 'INSERT INTO orders ...', []);

			expect(isForeignKeyConstraintError(err)).toBe(true);
			if (isForeignKeyConstraintError(err)) {
				expect(err.constraint).toBe('fk_orders_user');
			}
		});

		it('extracts not null error (ER_BAD_NULL_ERROR / 1048)', () => {
			const mysqlError = {
				code: 'ER_BAD_NULL_ERROR',
				errno: 1048,
				message: "Column 'created_at' cannot be null",
			};

			const err = wrapQueryError(mysqlError, 'INSERT INTO posts ...', []);

			expect(isNotNullConstraintError(err)).toBe(true);
			if (isNotNullConstraintError(err)) {
				expect(err.column).toBe('created_at');
			}
		});

		it('extracts check constraint violation (ER_CHECK_CONSTRAINT_VIOLATED / 3819)', () => {
			const mysqlError = {
				code: 'ER_CHECK_CONSTRAINT_VIOLATED',
				errno: 3819,
				message: "Check constraint 'chk_min_price' is violated.",
			};

			const err = wrapQueryError(mysqlError, 'INSERT INTO products ...', []);

			expect(isCheckConstraintError(err)).toBe(true);
			if (isCheckConstraintError(err)) {
				expect(err.constraint).toBe('chk_min_price');
			}
		});
	});

	describe('SQLite Constraint Extraction', () => {
		it('extracts UNIQUE constraint failed from message', () => {
			const sqliteError = new Error('UNIQUE constraint failed: users.email');

			const err = DrizzleQueryError.from('INSERT INTO users ...', [], sqliteError);

			expect(isUniqueConstraintError(err)).toBe(true);
			if (isUniqueConstraintError(err)) {
				expect(err.table).toBe('users');
				expect(err.column).toBe('email');
			}
		});

		it('extracts NOT NULL constraint failed from message', () => {
			const sqliteError = new Error('NOT NULL constraint failed: profiles.display_name');

			const err = DrizzleQueryError.from('INSERT INTO profiles ...', [], sqliteError);

			expect(isNotNullConstraintError(err)).toBe(true);
			if (isNotNullConstraintError(err)) {
				expect(err.table).toBe('profiles');
				expect(err.column).toBe('display_name');
			}
		});

		it('extracts FOREIGN KEY constraint failed from message', () => {
			const sqliteError = new Error('FOREIGN KEY constraint failed');

			const err = DrizzleQueryError.from('DELETE FROM users WHERE id = 1', [], sqliteError);

			expect(isForeignKeyConstraintError(err)).toBe(true);
		});

		it('extracts CHECK constraint failed from message', () => {
			const sqliteError = new Error('CHECK constraint failed: age >= 18');

			const err = DrizzleQueryError.from('INSERT INTO users ...', [], sqliteError);

			expect(isCheckConstraintError(err)).toBe(true);
		});
	});

	describe('Non-constraint and fallback errors', () => {
		it('falls back to standard DrizzleQueryError when error is not a constraint', () => {
			const syntaxError = new Error('syntax error at or near "SELCT"');
			const err = DrizzleQueryError.from('SELCT * FROM users', [], syntaxError);

			expect(err).toBeInstanceOf(DrizzleQueryError);
			expect(err).not.toBeInstanceOf(DrizzleConstraintError);
			expect(isDrizzleQueryError(err)).toBe(true);
			expect(isConstraintError(err)).toBe(false);
			expect(err.query).toBe('SELCT * FROM users');
			expect(err.cause).toBe(syntaxError);
		});

		it('handles undefined or non-object errors gracefully in extractConstraintInfo', () => {
			expect(extractConstraintInfo(null)).toBeUndefined();
			expect(extractConstraintInfo(undefined)).toBeUndefined();
			expect(extractConstraintInfo('plain string error')).toBeUndefined();
			expect(extractConstraintInfo(123)).toBeUndefined();
		});
	});
});
