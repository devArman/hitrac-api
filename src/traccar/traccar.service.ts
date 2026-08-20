import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Клиент Traccar API под служебным админ-аккаунтом.
 * Единственное место, где платформа общается с Traccar: отчёты, команды
 * трекерам, создание устройств. Всё остальное читается из базы напрямую.
 */
@Injectable()
export class TraccarService {
  private readonly base: string;
  private readonly auth: string;

  constructor(config: ConfigService) {
    this.base = config.get<string>('TRACCAR_URL') ?? 'http://127.0.0.1:8082/api';
    const email = config.get<string>('TRACCAR_EMAIL') ?? '';
    const password = config.get<string>('TRACCAR_PASSWORD') ?? '';
    this.auth = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  }

  async request(path: string, options: { method?: string; body?: unknown; params?: Record<string, string | string[]> } = {}) {
    const url = new URL(this.base + path);
    Object.entries(options.params ?? {}).forEach(([key, value]) => {
      (Array.isArray(value) ? value : [value]).forEach((v) => url.searchParams.append(key, v));
    });
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new InternalServerErrorException(`Traccar: ${text.split('\n')[0] || response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }
}
