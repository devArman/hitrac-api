import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { FuelWatcherService } from './fuel-watcher.service';
import { TowWatcherService } from './tow-watcher.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, FuelWatcherService, TowWatcherService],
  exports: [DevicesService],
})
export class DevicesModule {}
