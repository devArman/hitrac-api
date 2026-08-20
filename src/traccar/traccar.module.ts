import { Global, Module } from '@nestjs/common';
import { TraccarService } from './traccar.service';

@Global()
@Module({
  providers: [TraccarService],
  exports: [TraccarService],
})
export class TraccarModule {}
