<script setup>
import { computed, ref } from 'vue';
import { UploadCloud } from 'lucide-vue-next';
const props=defineProps({file:{type:File,default:null},accept:{type:String,default:'image/png,image/jpeg,image/webp'},maxMb:{type:Number,default:5},preview:{type:String,default:''},progress:{type:Number,default:null},busy:{type:Boolean,default:false},label:{type:String,default:'Choose file or photo'},hint:{type:String,default:'Drag a file here or use the button.'}});
const emit=defineEmits(['select','remove']);
const input=ref(null),dragging=ref(false),error=ref('');
const size=computed(()=>props.file?`${(props.file.size/1048576).toFixed(2)} MB`:'');
function choose(file){if(!file||props.busy)return;const types=props.accept.split(',').map(value=>value.trim());if(!types.includes(file.type)){error.value=`Use one of: ${types.join(', ')}.`;return;}if(file.size>props.maxMb*1048576){error.value=`File must be ${props.maxMb} MB or smaller.`;return;}error.value='';emit('select',file);}
function dropped(event){dragging.value=false;choose(event.dataTransfer?.files?.[0]);}
function remove(){emit('remove');if(input.value)input.value.value='';error.value='';}
</script>
<template><div class="file-upload" :class="{dragging,busy}" @dragover.prevent="dragging=!busy" @dragleave.prevent="dragging=false" @drop.prevent="dropped"><label class="file-upload-label"><UploadCloud :size="22"/><span>{{label}}</span><input ref="input" type="file" :accept="accept" :disabled="busy" @click="$event.target.value=''" @change="choose($event.target.files?.[0])"/></label><p>{{hint}} · Up to {{maxMb}} MB.</p><div v-if="file" class="file-upload-selected"><strong>{{file.name}}</strong><span>{{size}}</span><button type="button" class="text-button" :disabled="busy" @click="input?.click()">Replace</button><button type="button" class="text-button" :disabled="busy" @click="remove">Remove</button></div><img v-if="preview" class="file-upload-preview" :src="preview" alt="Selected file preview"/><p v-if="error" class="form-error" role="alert">{{error}}</p><p v-if="busy" role="status">{{progress==null?'Uploading and processing…':progress<100?`Uploading ${progress}%`:'Processing on server…'}}</p><progress v-if="busy&&progress!=null" :value="progress" max="100" :aria-label="`Uploaded ${progress}%`"/></div></template>
