import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { FuelWatcherService } from './fuel-watcher.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, FuelWatcherService],
  exports: [DevicesService],
})
export class DevicesModule {}
