/**
 * @fileoverview Audit Event Archival Service
 *
 * Archives old audit events from D1 to R2 for long-term storage.
 * Reduces D1 database size while maintaining audit trail for compliance.
 *
 * Archive format: audits/{year}/{month}/{day}/events-{timestamp}.json
 * Each file contains a batch of events as a JSON array.
 */

import { logger } from '../logger';

export interface ArchivalConfig {
	/** Number of days to keep in D1 before archiving (default: 30) */
	retentionDays?: number;
	/** Maximum events to archive per run (default: 10000) */
	batchSize?: number;
}

export interface ArchivalResult {
	eventsArchived: number;
	eventsDeleted: number;
	filesCreated: number;
	duration: number;
	errors: string[];
}

interface AuditEventRow {
	id: string;
	event_type: string;
	timestamp: string;
	user_id: string | null;
	ip_address: string | null;
	user_agent: string | null;
	severity: string;
	success: number;
	metadata: string | null;
}

/**
 * Archive old audit events from D1 to R2
 *
 * @param db - D1 database containing audit_events table
 * @param r2 - R2 bucket for archive storage
 * @param config - Archival configuration
 */
export async function archiveAuditEvents(
	db: D1Database,
	r2: R2Bucket,
	config: ArchivalConfig = {}
): Promise<ArchivalResult> {
	const startTime = Date.now();
	const retentionDays = config.retentionDays ?? 30;
	const batchSize = config.batchSize ?? 10000;
	const errors: string[] = [];

	let eventsArchived = 0;
	let eventsDeleted = 0;
	let filesCreated = 0;

	try {
		// Calculate cutoff timestamp
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
		const cutoffTimestamp = cutoffDate.toISOString();

		logger.info('Starting audit event archival', {
			retentionDays,
			cutoffTimestamp,
			batchSize,
		});

		// Fetch old events
		const result = await db
			.prepare(
				`SELECT id, event_type, timestamp, user_id, ip_address, user_agent, severity, success, metadata
				 FROM audit_events
				 WHERE timestamp < ?
				 ORDER BY timestamp ASC
				 LIMIT ?`
			)
			.bind(cutoffTimestamp, batchSize)
			.all<AuditEventRow>();

		const events = result.results || [];

		if (events.length === 0) {
			logger.info('No events to archive');
			return {
				eventsArchived: 0,
				eventsDeleted: 0,
				filesCreated: 0,
				duration: Date.now() - startTime,
				errors: [],
			};
		}

		logger.info('Found events to archive', { count: events.length });

		// Group events by date for organized storage
		const eventsByDate = new Map<string, AuditEventRow[]>();
		for (const event of events) {
			const date = event.timestamp.split('T')[0]; // YYYY-MM-DD
			if (!eventsByDate.has(date)) {
				eventsByDate.set(date, []);
			}
			eventsByDate.get(date)!.push(event);
		}

		// Write each date's events to R2
		const eventIds: string[] = [];
		for (const [date, dateEvents] of eventsByDate) {
			try {
				const [year, month, day] = date.split('-');
				const timestamp = Date.now();
				const key = `audits/${year}/${month}/${day}/events-${timestamp}.json`;

				// Convert to clean JSON (parse metadata)
				const cleanEvents = dateEvents.map((e) => ({
					id: e.id,
					eventType: e.event_type,
					timestamp: e.timestamp,
					userId: e.user_id,
					ipAddress: e.ip_address,
					userAgent: e.user_agent,
					severity: e.severity,
					success: e.success === 1,
					metadata: e.metadata ? JSON.parse(e.metadata) : null,
				}));

				await r2.put(key, JSON.stringify(cleanEvents, null, 2), {
					httpMetadata: {
						contentType: 'application/json',
					},
					customMetadata: {
						eventCount: String(dateEvents.length),
						dateRange: date,
						archivedAt: new Date().toISOString(),
					},
				});

				filesCreated++;
				eventsArchived += dateEvents.length;
				eventIds.push(...dateEvents.map((e) => e.id));

				logger.debug('Archived events to R2', {
					key,
					count: dateEvents.length,
					date,
				});
			} catch (error) {
				const errorMsg = `Failed to archive events for ${date}: ${error instanceof Error ? error.message : String(error)}`;
				errors.push(errorMsg);
				logger.error(errorMsg);
			}
		}

		// Delete archived events from D1
		if (eventIds.length > 0) {
			// Delete in batches to avoid query size limits
			const deleteChunkSize = 500;
			for (let i = 0; i < eventIds.length; i += deleteChunkSize) {
				const chunk = eventIds.slice(i, i + deleteChunkSize);
				const placeholders = chunk.map(() => '?').join(',');

				try {
					const deleteResult = await db
						.prepare(`DELETE FROM audit_events WHERE id IN (${placeholders})`)
						.bind(...chunk)
						.run();

					eventsDeleted += deleteResult.meta?.changes || 0;
				} catch (error) {
					const errorMsg = `Failed to delete archived events: ${error instanceof Error ? error.message : String(error)}`;
					errors.push(errorMsg);
					logger.error(errorMsg);
				}
			}
		}

		const duration = Date.now() - startTime;
		logger.info('Audit event archival completed', {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration,
			errors: errors.length,
		});

		return {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration,
			errors,
		};
	} catch (error) {
		const errorMsg = `Archival failed: ${error instanceof Error ? error.message : String(error)}`;
		errors.push(errorMsg);
		logger.error(errorMsg);

		return {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration: Date.now() - startTime,
			errors,
		};
	}
}

/**
 * Archive old token_usage events from D1 to R2
 *
 * @param db - D1 database containing token_usage table
 * @param r2 - R2 bucket for archive storage
 * @param config - Archival configuration
 */
export async function archiveTokenUsageEvents(
	db: D1Database,
	r2: R2Bucket,
	config: ArchivalConfig = {}
): Promise<ArchivalResult> {
	const startTime = Date.now();
	const retentionDays = config.retentionDays ?? 30;
	const batchSize = config.batchSize ?? 10000;
	const errors: string[] = [];

	let eventsArchived = 0;
	let eventsDeleted = 0;
	let filesCreated = 0;

	try {
		// Calculate cutoff timestamp (token_usage uses unix epoch milliseconds)
		const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		logger.info('Starting token_usage archival', {
			retentionDays,
			cutoffTimestamp,
			batchSize,
		});

		// Fetch old events
		const result = await db
			.prepare(
				`SELECT id, token_id, subject, event_type, client_id, ip_address, user_agent, timestamp, metadata
				 FROM token_usage
				 WHERE timestamp < ?
				 ORDER BY timestamp ASC
				 LIMIT ?`
			)
			.bind(cutoffTimestamp, batchSize)
			.all();

		const events = result.results || [];

		if (events.length === 0) {
			logger.info('No token_usage events to archive');
			return {
				eventsArchived: 0,
				eventsDeleted: 0,
				filesCreated: 0,
				duration: Date.now() - startTime,
				errors: [],
			};
		}

		logger.info('Found token_usage events to archive', { count: events.length });

		// Group events by date
		const eventsByDate = new Map<string, typeof events>();
		for (const event of events) {
			const date = new Date(event.timestamp as number).toISOString().split('T')[0];
			if (!eventsByDate.has(date)) {
				eventsByDate.set(date, []);
			}
			eventsByDate.get(date)!.push(event);
		}

		// Write each date's events to R2
		const eventIds: string[] = [];
		for (const [date, dateEvents] of eventsByDate) {
			try {
				const [year, month, day] = date.split('-');
				const timestamp = Date.now();
				const key = `token-usage/${year}/${month}/${day}/events-${timestamp}.json`;

				// Convert to clean JSON
				const cleanEvents = dateEvents.map((e) => ({
					id: e.id,
					tokenId: e.token_id,
					subject: e.subject,
					eventType: e.event_type,
					clientId: e.client_id,
					ipAddress: e.ip_address,
					userAgent: e.user_agent,
					timestamp: e.timestamp,
					metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
				}));

				await r2.put(key, JSON.stringify(cleanEvents, null, 2), {
					httpMetadata: {
						contentType: 'application/json',
					},
					customMetadata: {
						eventCount: String(dateEvents.length),
						dateRange: date,
						archivedAt: new Date().toISOString(),
					},
				});

				filesCreated++;
				eventsArchived += dateEvents.length;
				eventIds.push(...dateEvents.map((e) => e.id as string));

				logger.debug('Archived token_usage events to R2', {
					key,
					count: dateEvents.length,
					date,
				});
			} catch (error) {
				const errorMsg = `Failed to archive token_usage for ${date}: ${error instanceof Error ? error.message : String(error)}`;
				errors.push(errorMsg);
				logger.error(errorMsg);
			}
		}

		// Delete archived events from D1
		if (eventIds.length > 0) {
			const deleteChunkSize = 500;
			for (let i = 0; i < eventIds.length; i += deleteChunkSize) {
				const chunk = eventIds.slice(i, i + deleteChunkSize);
				const placeholders = chunk.map(() => '?').join(',');

				try {
					const deleteResult = await db
						.prepare(`DELETE FROM token_usage WHERE id IN (${placeholders})`)
						.bind(...chunk)
						.run();

					eventsDeleted += deleteResult.meta?.changes || 0;
				} catch (error) {
					const errorMsg = `Failed to delete archived token_usage: ${error instanceof Error ? error.message : String(error)}`;
					errors.push(errorMsg);
					logger.error(errorMsg);
				}
			}
		}

		const duration = Date.now() - startTime;
		logger.info('Token usage archival completed', {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration,
			errors: errors.length,
		});

		return {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration,
			errors,
		};
	} catch (error) {
		const errorMsg = `Token usage archival failed: ${error instanceof Error ? error.message : String(error)}`;
		errors.push(errorMsg);
		logger.error(errorMsg);

		return {
			eventsArchived,
			eventsDeleted,
			filesCreated,
			duration: Date.now() - startTime,
			errors,
		};
	}
}
