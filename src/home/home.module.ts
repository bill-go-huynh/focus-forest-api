import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ForestModule } from '../forest/forest.module.js';
import { TopicsModule } from '../topics/topics.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { HomeController } from './home.controller.js';

/** Home in one request (A3.3, with the month-end ceremony state from A3.4). */
@Module({
  imports: [ConsistencyModule, TopicsModule, TreesModule, ForestModule],
  controllers: [HomeController],
})
export class HomeModule {}
